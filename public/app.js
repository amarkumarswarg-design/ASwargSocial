// ==================== Configuration ====================
const API_BASE = '';
let socket = null;
let currentUser = null;
let currentChatUser = null;
let currentGroup = null;
let activeChatId = null;
let activeGroupId = null;
let cropper = null;
let currentPostId = null;
let stories = [];
let unsavedChanges = false;

// DOM Elements (cached after login)
let loadingEl, authContainer, mainContainer, contentArea, bottomNavItems, headerLogout;

// ==================== Helper Functions ====================
function showLoading() { loadingEl?.classList.remove('hidden'); }
function hideLoading() { loadingEl?.classList.add('hidden'); }

function getToken() { return localStorage.getItem('token'); }
function setToken(token) {
  if (token) localStorage.setItem('token', token);
  else localStorage.removeItem('token');
}

async function apiRequest(endpoint, options = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function debounce(fn, delay) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

function formatTime(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function formatExactTime(dateString) {
  const date = new Date(dateString);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateHeader(dateString) {
  const date = new Date(dateString);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ==================== Custom Popup ====================
function showPopup(message, type = 'info', callback = null) {
  const modal = document.getElementById('popup-modal');
  const titleEl = document.getElementById('popup-title');
  const msgEl = document.getElementById('popup-message');
  const confirmBtn = document.getElementById('popup-confirm');
  const cancelBtn = document.getElementById('popup-cancel');

  msgEl.textContent = message;

  if (type === 'success') titleEl.textContent = '✅ Success';
  else if (type === 'error') titleEl.textContent = '❌ Error';
  else if (type === 'warning') titleEl.textContent = '⚠️ Warning';
  else if (type === 'confirm') titleEl.textContent = 'Confirm';
  else titleEl.textContent = 'ℹ️ Info';

  if (type === 'confirm') {
    cancelBtn.classList.remove('hidden');
    confirmBtn.textContent = 'Yes';
  } else {
    cancelBtn.classList.add('hidden');
    confirmBtn.textContent = 'OK';
  }

  modal.classList.add('active');

  confirmBtn.onclick = () => {
    modal.classList.remove('active');
    if (callback) callback(true);
  };

  cancelBtn.onclick = () => {
    modal.classList.remove('active');
    if (callback) callback(false);
  };

  document.querySelector('.close-popup').onclick = () => {
    modal.classList.remove('active');
    if (callback) callback(false);
  };
}

// ==================== Unsaved Changes Warning ====================
window.addEventListener('beforeunload', (e) => {
  if (unsavedChanges) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ==================== Initialization ====================
document.addEventListener('DOMContentLoaded', async () => {
  loadingEl = document.getElementById('loading');
  authContainer = document.getElementById('auth-container');
  mainContainer = document.getElementById('main-container');
  contentArea = document.getElementById('content-area');
  bottomNavItems = document.querySelectorAll('.nav-item');
  headerLogout = document.getElementById('logout-btn');

  if (getToken()) {
    try {
      showLoading();
      currentUser = await apiRequest('/api/auth/me');
      authContainer.classList.add('hidden');
      mainContainer.classList.remove('hidden');
      initApp();
    } catch (err) {
      setToken(null);
      showAuth();
    } finally {
      hideLoading();
    }
  } else {
    showAuth();
  }

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
      document.getElementById(`${tab}-form`).classList.add('active');
      document.getElementById('ssn-display').classList.add('hidden');
    });
  });

  const regDp = document.getElementById('reg-dp');
  const dpPreview = document.getElementById('dp-preview');
  const dpPreviewContainer = document.getElementById('dp-preview-container');
  const cropBtn = document.getElementById('crop-btn');
  regDp.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        dpPreview.src = reader.result;
        dpPreviewContainer.classList.remove('hidden');
        if (cropper) cropper.destroy();
        cropper = new Cropper(dpPreview, { aspectRatio: 1, viewMode: 1 });
      };
      reader.readAsDataURL(file);
    }
  });
  cropBtn.addEventListener('click', () => {
    if (cropper) {
      const canvas = cropper.getCroppedCanvas({ width: 500, height: 500 });
      canvas.toBlob((blob) => {
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onload = () => {
          window.regDpBase64 = reader.result;
          showPopup('Image cropped. Complete registration.', 'success');
        };
      }, 'image/jpeg');
    }
  });

  document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('reg-name').value;
    const username = document.getElementById('reg-username').value;
    const password = document.getElementById('reg-password').value;
    const profilePic = window.regDpBase64 || '';
    try {
      showLoading();
      const data = await apiRequest('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name, username, password, profilePic })
      });
      setToken(data.token);
      currentUser = data.user;
      document.getElementById('register-message').style.color = 'green';
      document.getElementById('register-message').textContent = 'Registration successful!';
      document.getElementById('ssn-value').textContent = data.user.ssn;
      document.getElementById('ssn-display').classList.remove('hidden');
      showPopup('Registration successful! You will be logged in.', 'success');
      setTimeout(() => window.location.reload(), 2000);
    } catch (err) {
      document.getElementById('register-message').style.color = 'red';
      document.getElementById('register-message').textContent = err.message;
      showPopup(err.message, 'error');
    } finally {
      hideLoading();
    }
  });

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const identifier = document.getElementById('login-identifier').value;
    const password = document.getElementById('login-password').value;
    try {
      showLoading();
      const data = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier, password })
      });
      setToken(data.token);
      currentUser = data.user;
      authContainer.classList.add('hidden');
      mainContainer.classList.remove('hidden');
      showPopup(`Welcome back, ${data.user.name}!`, 'success');
      initApp();
    } catch (err) {
      document.getElementById('login-message').style.color = 'red';
      document.getElementById('login-message').textContent = err.message;
      showPopup(err.message, 'error');
    } finally {
      hideLoading();
    }
  });

  document.getElementById('copy-ssn').addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('ssn-value').textContent);
    showPopup('SSN copied to clipboard!', 'success');
  });

  headerLogout?.addEventListener('click', () => {
    setToken(null);
    window.location.reload();
  });

  document.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));
    });
  });

  // Edit profile modal save
  document.getElementById('save-profile')?.addEventListener('click', saveProfile);
  document.getElementById('edit-dp')?.addEventListener('change', handleEditDp);
  document.getElementById('delete-account-btn')?.addEventListener('click', deleteAccount);

  // Group settings
  document.getElementById('generate-invite')?.addEventListener('click', generateInviteLink);
});

function showAuth() {
  authContainer.classList.remove('hidden');
  mainContainer.classList.add('hidden');
}

function initApp() {
  socket = io({ auth: { token: getToken() } });
  socket.on('connect', () => console.log('Socket connected'));
  socket.on('connect_error', (err) => showPopup('Socket connection error: ' + err.message, 'error'));
  socket.on('private message', handleIncomingPrivateMessage);
  socket.on('group message', handleIncomingGroupMessage);
  socket.on('system notification', (data) => {
    showPopup(`🔊 ${data.from}: ${data.message}`, 'info');
  });

  bottomNavItems.forEach(item => {
    item.addEventListener('click', () => {
      bottomNavItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      loadView(item.dataset.view);
    });
  });

  loadView('feed');

  if (currentUser?.isBot) {
    const header = document.querySelector('.app-header');
    const botBtn = document.createElement('button');
    botBtn.className = 'btn-icon';
    botBtn.innerHTML = '<i class="fas fa-robot"></i>';
    botBtn.onclick = () => document.getElementById('bot-modal').classList.add('active');
    header.appendChild(botBtn);

    document.getElementById('send-broadcast').addEventListener('click', async () => {
      const msg = document.getElementById('broadcast-message').value;
      if (!msg) return;
      try {
        await apiRequest('/api/bot/broadcast', {
          method: 'POST',
          body: JSON.stringify({ message: msg })
        });
        showPopup('Broadcast sent!', 'success');
        document.getElementById('bot-modal').classList.remove('active');
        document.getElementById('broadcast-message').value = '';
      } catch (err) {
        showPopup(err.message, 'error');
      }
    });
  }

  document.getElementById('save-contact').addEventListener('click', async () => {
    const ssn = document.getElementById('contact-ssn').value.trim();
    const nickname = document.getElementById('contact-nickname').value.trim();
    if (!ssn) return showPopup('Enter SSN', 'warning');
    try {
      await apiRequest('/api/contacts', {
        method: 'POST',
        body: JSON.stringify({ contactSsn: ssn, nickname })
      });
      document.getElementById('add-contact-modal').classList.remove('active');
      document.getElementById('contact-ssn').value = '';
      document.getElementById('contact-nickname').value = '';
      showPopup('Contact added', 'success');
      if (document.getElementById('chats-view')?.classList.contains('active')) {
        loadView('chats');
      }
    } catch (err) {
      showPopup(err.message, 'error');
    }
  });

  document.getElementById('create-group-btn').addEventListener('click', async () => {
    const name = document.getElementById('group-name').value.trim();
    if (!name) return showPopup('Enter group name', 'warning');
    const selected = document.querySelectorAll('#contact-select-list input:checked');
    const members = Array.from(selected).map(cb => cb.value);
    try {
      await apiRequest('/api/groups', {
        method: 'POST',
        body: JSON.stringify({ name, members })
      });
      document.getElementById('create-group-modal').classList.remove('active');
      document.getElementById('group-name').value = '';
      showPopup('Group created', 'success');
      loadView('chats');
    } catch (err) {
      showPopup(err.message, 'error');
    }
  });
}

async function loadView(view, param) {
  contentArea.innerHTML = '';
  unsavedChanges = false;
  if (view === 'feed') await renderFeed();
  else if (view === 'search') renderSearch();
  else if (view === 'create') renderCreate();
  else if (view === 'chats') await renderChats();
  else if (view === 'profile') await renderProfile(param || currentUser._id);
}

// ==================== Feed ====================
async function renderFeed() {
  contentArea.innerHTML = `
    <div class="view active" id="feed-view">
      <div class="story-row" id="story-row"></div>
      <div id="feed-posts"></div>
    </div>
  `;
  await loadStories();
  await loadFeedPosts();
}

async function loadStories() {
  try {
    const storiesData = await apiRequest('/api/stories/feed');
    const container = document.getElementById('story-row');
    container.innerHTML = `
      <div class="story-item add-story" id="add-story-btn">
        <div class="story-avatar">
          <i class="fas fa-plus"></i>
        </div>
        <span class="story-name">Add</span>
      </div>
    ` + storiesData.map(s => `
      <div class="story-item" data-story-id="${s._id}">
        <div class="story-avatar">
          <img src="${s.user.profilePic || 'https://via.placeholder.com/60'}" alt="">
        </div>
        <span class="story-name">${s.user.username}</span>
      </div>
    `).join('');

    document.getElementById('add-story-btn').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = async () => {
            try {
              showLoading();
              await apiRequest('/api/stories', {
                method: 'POST',
                body: JSON.stringify({ media: reader.result })
              });
              showPopup('Story posted!', 'success');
              loadView('feed');
            } catch (err) {
              showPopup(err.message, 'error');
            } finally {
              hideLoading();
            }
          };
          reader.readAsDataURL(file);
        }
      };
      input.click();
    });

    document.querySelectorAll('.story-item[data-story-id]').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.dataset.storyId;
        const story = storiesData.find(s => s._id === id);
        if (story) showStory(story);
      });
    });
  } catch (err) {
    console.error(err);
  }
}

function showStory(story) {
  const modal = document.getElementById('story-viewer-modal');
  document.getElementById('story-username').textContent = story.user.username;
  document.getElementById('story-image-container').innerHTML = `<img src="${story.media.url}" alt="Story">`;
  modal.classList.add('active');
}

async function loadFeedPosts() {
  try {
    const posts = await apiRequest('/api/posts/feed?page=1');
    document.getElementById('feed-posts').innerHTML = posts.map(post => renderPost(post)).join('');
    attachPostListeners();
  } catch (err) {
    console.error(err);
  }
}

function renderPost(post) {
  const liked = post.likes.includes(currentUser._id);
  const isOwn = post.user._id === currentUser._id;
  return `
    <div class="post-card" data-post-id="${post._id}">
      <div class="post-header" onclick="openProfile('${post.user._id}')">
        <img src="${post.user.profilePic || 'https://via.placeholder.com/40'}" class="post-avatar">
        <div>
          <div class="post-user">
            ${post.user.name} @${post.user.username}
            ${post.user.verified ? '<span class="verified-badge">✓</span>' : ''}
            ${post.user.ownerBadge ? '<span class="owner-badge">👑</span>' : ''}
          </div>
          <div class="post-time">${formatTime(post.createdAt)}</div>
        </div>
        ${isOwn ? `<button class="delete-post-btn" data-post-id="${post._id}"><i class="fas fa-trash"></i></button>` : ''}
      </div>
      <div class="post-content">${post.content || ''}</div>
      ${post.media.map(m => m.type === 'image' ? `<img src="${m.url}" class="post-media">` : '').join('')}
      <div class="post-actions">
        <button class="like-btn ${liked ? 'liked' : ''}" data-post-id="${post._id}">
          <i class="fas fa-heart"></i> <span class="like-count">${post.likes.length}</span>
        </button>
        <button class="comment-btn" data-post-id="${post._id}">
          <i class="fas fa-comment"></i> <span class="comment-count">${post.comments.length}</span>
        </button>
      </div>
    </div>
  `;
}

function attachPostListeners() {
  document.querySelectorAll('.like-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const postId = btn.dataset.postId;
      try {
        const data = await apiRequest(`/api/posts/${postId}/like`, { method: 'PUT' });
        btn.querySelector('.like-count').textContent = data.likes.length;
        btn.classList.toggle('liked');
      } catch (err) { showPopup(err.message, 'error'); }
    });
  });

  document.querySelectorAll('.comment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentPostId = btn.dataset.postId;
      loadCommentsModal(currentPostId);
    });
  });

  document.querySelectorAll('.delete-post-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const postId = btn.dataset.postId;
      showPopup('Delete this post?', 'confirm', async (confirmed) => {
        if (confirmed) {
          try {
            await apiRequest(`/api/posts/${postId}`, { method: 'DELETE' });
            btn.closest('.post-card').remove();
            showPopup('Post deleted', 'success');
          } catch (err) {
            showPopup(err.message, 'error');
          }
        }
      });
    });
  });
}

async function loadCommentsModal(postId) {
  try {
    const post = await apiRequest(`/api/posts/${postId}`);
    const modal = document.getElementById('comments-modal');
    const list = document.getElementById('comments-list');
    list.innerHTML = post.comments.map(c => `
      <div class="comment-item">
        <img src="${c.user.profilePic || 'https://via.placeholder.com/30'}" class="comment-avatar">
        <div>
          <strong>@${c.user.username}</strong> ${c.text}
          <div class="comment-time">${formatTime(c.createdAt)}</div>
        </div>
        ${c.user._id === currentUser._id ? `<button class="delete-comment" data-comment-id="${c._id}"><i class="fas fa-trash"></i></button>` : ''}
      </div>
    `).join('');
    modal.classList.add('active');

    document.getElementById('submit-comment').onclick = async () => {
      const text = document.getElementById('comment-input').value;
      if (!text) return;
      await apiRequest(`/api/posts/${postId}/comment`, {
        method: 'POST',
        body: JSON.stringify({ text })
      });
      document.getElementById('comment-input').value = '';
      loadCommentsModal(postId);
      const countSpan = document.querySelector(`.comment-btn[data-post-id="${postId}"] .comment-count`);
      if (countSpan) countSpan.textContent = parseInt(countSpan.textContent) + 1;
    };

    document.querySelectorAll('.delete-comment').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const commentId = e.currentTarget.dataset.commentId;
        await apiRequest(`/api/posts/${postId}/comment/${commentId}`, { method: 'DELETE' });
        loadCommentsModal(postId);
      });
    });
  } catch (err) { showPopup(err.message, 'error'); }
}

// ==================== Search ====================
async function renderSearch() {
  contentArea.innerHTML = `
    <div class="view active" id="search-view">
      <div class="search-box glass-card">
        <i class="fas fa-search"></i>
        <input type="text" id="search-input" placeholder="Search by username...">
      </div>
      <div id="search-results"></div>
    </div>
  `;
  document.getElementById('search-input').addEventListener('input', debounce(handleSearch, 500));
  // Load all users initially
  await loadAllUsers();
}

async function loadAllUsers() {
  try {
    const users = await apiRequest('/api/users/all?page=1');
    displayUsers(users);
  } catch (err) {
    showPopup(err.message, 'error');
  }
}

function displayUsers(users) {
  const resultsDiv = document.getElementById('search-results');
  resultsDiv.innerHTML = users.map(u => `
    <div class="user-item" data-user-id="${u._id}">
      <img src="${u.profilePic || 'https://via.placeholder.com/50'}">
      <div class="user-info">
        <h4>
          ${u.name} @${u.username}
          ${u.verified ? '<span class="verified-badge">✓</span>' : ''}
          ${u.ownerBadge ? '<span class="owner-badge">👑</span>' : ''}
        </h4>
        <p>${u.ssn}</p>
      </div>
      <button class="follow-btn btn-secondary" data-user-id="${u._id}">${u.isFollowing ? 'Unfollow' : 'Follow'}</button>
      <button class="chat-btn btn-primary" data-user-id="${u._id}"><i class="fas fa-comment"></i></button>
    </div>
  `).join('');

  document.querySelectorAll('.user-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (!e.target.closest('button')) openProfile(item.dataset.userId);
    });
  });

  document.querySelectorAll('.follow-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const userId = btn.dataset.userId;
      await toggleFollow(userId, btn);
    });
  });

  document.querySelectorAll('.chat-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await navigateToChat(btn.dataset.userId);
    });
  });
}

async function handleSearch() {
  const query = document.getElementById('search-input').value.trim();
  if (query.length < 2) {
    loadAllUsers();
    return;
  }
  try {
    const users = await apiRequest(`/api/users/search?q=${encodeURIComponent(query)}`);
    displayUsers(users);
  } catch (err) { showPopup(err.message, 'error'); }
}

// ==================== Create Post ====================
function renderCreate() {
  contentArea.innerHTML = `
    <div class="view active" id="create-view">
      <div class="create-post-card glass-card">
        <textarea id="post-content" placeholder="What's on your mind?" rows="3" oninput="unsavedChanges=true"></textarea>
        <div class="media-preview" id="media-preview"></div>
        <div class="create-post-actions">
          <input type="file" id="post-media" accept="image/*" hidden>
          <button class="btn-secondary" id="attach-media"><i class="fas fa-image"></i> Add Image</button>
          <button class="btn-primary" id="submit-post">Post</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('attach-media').addEventListener('click', () => {
    document.getElementById('post-media').click();
  });

  document.getElementById('post-media').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        document.getElementById('media-preview').innerHTML = `<img src="${reader.result}" style="max-width:100px; border-radius:10px;">`;
        window.postMediaBase64 = reader.result;
        unsavedChanges = true;
      };
      reader.readAsDataURL(file);
    }
  });

  document.getElementById('submit-post').addEventListener('click', async () => {
    const content = document.getElementById('post-content').value;
    const mediaBase64 = window.postMediaBase64;
    if (!content && !mediaBase64) return;
    const media = mediaBase64 ? [{ url: mediaBase64, type: 'image' }] : [];
    const btn = document.getElementById('submit-post');
    const originalText = btn.textContent;
    btn.textContent = 'Posting...';
    btn.disabled = true;
    try {
      await apiRequest('/api/posts', { method: 'POST', body: JSON.stringify({ content, media }) });
      document.getElementById('post-content').value = '';
      document.getElementById('media-preview').innerHTML = '';
      delete window.postMediaBase64;
      unsavedChanges = false;
      showPopup('Post created!', 'success');
      loadView('feed');
    } catch (err) {
      showPopup(err.message, 'error');
    } finally {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  });
}

// ==================== Profile ====================
async function renderProfile(userId) {
  if (!currentUser) {
    try {
      currentUser = await apiRequest('/api/auth/me');
    } catch (err) {
      showPopup('Failed to fetch current user', 'error');
      return;
    }
  }
  const isOwn = userId === currentUser._id;
  try {
    const user = await apiRequest(`/api/users/${userId}`);
    const posts = await apiRequest(`/api/posts/user/${userId}`);
    let suggestions = [];
    if (isOwn) {
      suggestions = await apiRequest('/api/users/suggestions');
    }

    const profileHtml = `
      <div class="view active" id="profile-view">
        <div class="profile-header glass-card">
          <img src="${user.profilePic || 'https://via.placeholder.com/80'}" class="profile-avatar">
          <div>
            <h3>
              ${user.name} @${user.username}
              ${user.verified ? '<span class="verified-badge">✓</span>' : ''}
              ${user.ownerBadge ? '<span class="owner-badge">👑</span>' : ''}
            </h3>
            <p>SSN: ${user.ssn}</p>
            <div class="profile-stats">
              <div class="stat" id="followers-stat">
                <div class="stat-number">${user.followersCount || 0}</div>
                <div class="stat-label">Followers</div>
              </div>
              <div class="stat" id="following-stat">
                <div class="stat-number">${user.followingCount || 0}</div>
                <div class="stat-label">Following</div>
              </div>
            </div>
            ${!isOwn ? `<button class="follow-btn btn-primary" data-user-id="${userId}">${user.isFollowing ? 'Unfollow' : 'Follow'}</button>` : ''}
            ${isOwn ? `<button class="edit-profile-btn btn-secondary" id="open-edit-profile"><i class="fas fa-edit"></i> Edit Profile</button>` : ''}
          </div>
        </div>

        ${user.bio || user.work || user.education || user.location || user.relationship ? `
        <div class="profile-details glass-card">
          ${user.bio ? `<div class="detail-item"><i class="fas fa-quote-right"></i> ${user.bio}</div>` : ''}
          ${user.work ? `<div class="detail-item"><i class="fas fa-briefcase"></i> ${user.work}</div>` : ''}
          ${user.education ? `<div class="detail-item"><i class="fas fa-graduation-cap"></i> ${user.education}</div>` : ''}
          ${user.location ? `<div class="detail-item"><i class="fas fa-map-marker-alt"></i> ${user.location}</div>` : ''}
          ${user.relationship ? `<div class="detail-item"><i class="fas fa-heart"></i> ${user.relationship}</div>` : ''}
        </div>
        ` : ''}

        <div id="profile-posts" class="profile-posts">
          ${posts.map(p => renderPost(p)).join('')}
        </div>

        ${isOwn && suggestions.length > 0 ? `
        <div class="suggestions-row">
          ${suggestions.map(s => `
            <div class="suggestion-item" onclick="openProfile('${s._id}')">
              <img src="${s.profilePic || 'https://via.placeholder.com/60'}">
              <span>${s.username}</span>
            </div>
          `).join('')}
        </div>
        ` : ''}
      </div>
    `;
    contentArea.innerHTML = profileHtml;
    attachPostListeners();

    if (!isOwn) {
      document.querySelector('.follow-btn').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        await toggleFollow(userId, btn);
      });
    } else {
      document.getElementById('open-edit-profile').addEventListener('click', openEditProfileModal);
    }

    document.getElementById('followers-stat').addEventListener('click', () => showFollowList(userId, 'followers'));
    document.getElementById('following-stat').addEventListener('click', () => showFollowList(userId, 'following'));

  } catch (err) { showPopup(err.message, 'error'); }
}

async function toggleFollow(userId, btn) {
  const isFollowing = btn.textContent === 'Unfollow';
  try {
    if (isFollowing) {
      await apiRequest(`/api/follow/${userId}`, { method: 'DELETE' });
      btn.textContent = 'Follow';
    } else {
      await apiRequest(`/api/follow/${userId}`, { method: 'POST' });
      btn.textContent = 'Unfollow';
    }
    const stat = document.querySelector('.stat-number');
    if (stat) {
      const count = parseInt(stat.textContent);
      stat.textContent = isFollowing ? count - 1 : count + 1;
    }
  } catch (err) { showPopup(err.message, 'error'); }
}

async function showFollowList(userId, type) {
  try {
    const users = await apiRequest(`/api/users/${userId}/${type}`);
    const modal = document.getElementById(`${type}-modal`);
    const list = document.getElementById(`${type}-list`);
    list.innerHTML = users.map(u => `
      <div class="user-item" data-user-id="${u._id}">
        <img src="${u.profilePic || 'https://via.placeholder.com/40'}">
        <div class="user-info">
          <h4>
            ${u.name} @${u.username}
            ${u.verified ? '<span class="verified-badge">✓</span>' : ''}
            ${u.ownerBadge ? '<span class="owner-badge">👑</span>' : ''}
          </h4>
          <p>${u.ssn}</p>
        </div>
        <button class="btn-secondary view-profile">View Profile</button>
      </div>
    `).join('');
    modal.classList.add('active');

    document.querySelectorAll(`#${type}-list .view-profile`).forEach(btn => {
      btn.addEventListener('click', (e) => {
        const uid = e.target.closest('.user-item').dataset.userId;
        modal.classList.remove('active');
        openProfile(uid);
      });
    });
  } catch (err) { showPopup(err.message, 'error'); }
}

// Edit profile modal
let editDpBase64 = '';

function openEditProfileModal() {
  const modal = document.getElementById('edit-profile-modal');
  document.getElementById('edit-name').value = currentUser.name;
  document.getElementById('edit-username').value = currentUser.username;
  document.getElementById('edit-bio').value = currentUser.bio || '';
  document.getElementById('edit-work').value = currentUser.work || '';
  document.getElementById('edit-education').value = currentUser.education || '';
  document.getElementById('edit-location').value = currentUser.location || '';
  document.getElementById('edit-relationship').value = currentUser.relationship || '';
  document.getElementById('edit-dp-preview').innerHTML = currentUser.profilePic ? `<img src="${currentUser.profilePic}" width="50">` : '';
  modal.classList.add('active');
}

function handleEditDp(e) {
  const file = e.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = () => {
      editDpBase64 = reader.result;
      document.getElementById('edit-dp-preview').innerHTML = `<img src="${reader.result}" width="50" style="border-radius:10px;">`;
      unsavedChanges = true;
    };
    reader.readAsDataURL(file);
  }
}

async function saveProfile() {
  const updates = {};
  const name = document.getElementById('edit-name').value;
  if (name !== currentUser.name) updates.name = name;
  const username = document.getElementById('edit-username').value;
  if (username !== currentUser.username) updates.username = username;
  const bio = document.getElementById('edit-bio').value;
  if (bio !== currentUser.bio) updates.bio = bio;
  const work = document.getElementById('edit-work').value;
  if (work !== currentUser.work) updates.work = work;
  const education = document.getElementById('edit-education').value;
  if (education !== currentUser.education) updates.education = education;
  const location = document.getElementById('edit-location').value;
  if (location !== currentUser.location) updates.location = location;
  const relationship = document.getElementById('edit-relationship').value;
  if (relationship !== currentUser.relationship) updates.relationship = relationship;
  const password = document.getElementById('edit-password').value;
  if (password) updates.password = password;
  if (editDpBase64) updates.profilePic = editDpBase64;

  try {
    showLoading();
    const data = await apiRequest('/api/users/me', {
      method: 'PUT',
      body: JSON.stringify(updates)
    });
    currentUser = data;
    document.getElementById('edit-profile-modal').classList.remove('active');
    unsavedChanges = false;
    showPopup('Profile updated', 'success');
    loadView('profile', currentUser._id);
  } catch (err) {
    showPopup(err.message, 'error');
  } finally {
    hideLoading();
  }
}

async function deleteAccount() {
  const password = document.getElementById('delete-password').value;
  if (!password) return showPopup('Enter your password', 'warning');
  showPopup('This will permanently delete your account. Are you sure?', 'confirm', async (confirmed) => {
    if (confirmed) {
      try {
        await apiRequest('/api/users/me', {
          method: 'DELETE',
          body: JSON.stringify({ password })
        });
        setToken(null);
        window.location.reload();
      } catch (err) {
        showPopup(err.message, 'error');
      }
    }
  });
}

// ==================== Chats ====================
let currentChatTab = 'all';

async function renderChats() {
  contentArea.innerHTML = `
    <div class="view active" id="chats-view">
      <div class="chats-tabs">
        <button class="chat-tab ${currentChatTab === 'all' ? 'active' : ''}" data-tab="all">All</button>
        <button class="chat-tab ${currentChatTab === 'contacts' ? 'active' : ''}" data-tab="contacts">Contacts</button>
        <button class="chat-tab ${currentChatTab === 'groups' ? 'active' : ''}" data-tab="groups">Groups</button>
      </div>
      <div id="chats-list-container">
        <div class="chats-list" id="chats-list"></div>
      </div>
      <div class="chat-window hidden" id="chat-window">
        <div class="chat-header" id="chat-header"></div>
        <div class="chat-messages" id="chat-messages"></div>
        <div class="chat-input-area">
          <input type="text" id="chat-input" placeholder="Type a message...">
          <button id="send-chat"><i class="fas fa-paper-plane"></i></button>
          <input type="file" id="chat-media" accept="image/*" hidden>
          <button id="attach-chat-media" class="btn-icon"><i class="fas fa-image"></i></button>
        </div>
      </div>
    </div>
  `;

  document.querySelectorAll('.chat-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.chat-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentChatTab = tab.dataset.tab;
      loadChatListByTab();
    });
  });

  document.getElementById('attach-chat-media').addEventListener('click', () => {
    document.getElementById('chat-media').click();
  });
  document.getElementById('chat-media').addEventListener('change', handleChatMedia);

  await loadChatListByTab();
}

async function loadChatListByTab() {
  if (currentChatTab === 'all') await loadAllChats();
  else if (currentChatTab === 'contacts') await loadContactsList();
  else if (currentChatTab === 'groups') await loadGroupsList();
}

let chatMediaBase64 = null;
function handleChatMedia(e) {
  const file = e.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = () => {
      chatMediaBase64 = reader.result;
      showPopup('Image attached. Send message to upload.', 'success');
    };
    reader.readAsDataURL(file);
  }
}

async function loadAllChats() {
  try {
    const [chats, groups] = await Promise.all([
      apiRequest('/api/chats'),
      apiRequest('/api/groups')
    ]);

    const all = [
      ...chats.map(c => ({ ...c, type: 'chat' })),
      ...groups.map(g => ({ ...g, type: 'group' }))
    ];
    all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    const list = document.getElementById('chats-list');
    list.innerHTML = all.map(item => {
      if (item.type === 'chat') {
        return `
          <div class="chat-item" data-chat-id="${item._id}" data-user-id="${item.otherUser?._id}" data-type="chat">
            <img src="${item.otherUser?.profilePic || 'https://via.placeholder.com/50'}">
            <div class="chat-info">
              <div class="chat-name">
                ${item.otherUser?.name || 'Unknown'}
                ${item.otherUser?.verified ? '<span class="verified-badge">✓</span>' : ''}
                ${item.otherUser?.ownerBadge ? '<span class="owner-badge">👑</span>' : ''}
              </div>
              <div class="chat-last">${item.lastMessage?.content || 'No messages'}</div>
            </div>
            <div class="chat-time">${item.lastMessage ? formatTime(item.lastMessage.createdAt) : ''}</div>
          </div>
        `;
      } else {
        return `
          <div class="chat-item" data-group-id="${item._id}" data-type="group">
            <img src="${item.dp || 'https://via.placeholder.com/50'}">
            <div class="chat-info">
              <div class="chat-name">${item.name}</div>
              <div class="chat-last">${item.lastMessage?.content || 'No messages'}</div>
            </div>
            <div class="chat-time">${item.lastMessage ? formatTime(item.lastMessage.createdAt) : ''}</div>
          </div>
        `;
      }
    }).join('');
    attachChatItemListeners();
  } catch (err) { showPopup(err.message, 'error'); }
}

async function loadGroupsList() {
  try {
    const groups = await apiRequest('/api/groups');
    const list = document.getElementById('chats-list');
    list.innerHTML = groups.map(g => `
      <div class="chat-item" data-group-id="${g._id}" data-type="group">
        <img src="${g.dp || 'https://via.placeholder.com/50'}">
        <div class="chat-info">
          <div class="chat-name">${g.name}</div>
          <div class="chat-last">${g.lastMessage?.content || 'No messages'}</div>
        </div>
        <div class="chat-time">${g.lastMessage ? formatTime(g.lastMessage.createdAt) : ''}</div>
      </div>
    `).join('');
    attachChatItemListeners();
  } catch (err) { showPopup(err.message, 'error'); }
}

async function loadContactsList() {
  try {
    const contacts = await apiRequest('/api/contacts');
    const list = document.getElementById('chats-list');
    list.innerHTML = contacts.map(c => `
      <div class="chat-item" data-user-id="${c.contact._id}" data-type="contact">
        <img src="${c.contact.profilePic || 'https://via.placeholder.com/50'}">
        <div class="chat-info">
          <div class="chat-name">
            ${c.nickname || c.contact.name}
            ${c.contact.verified ? '<span class="verified-badge">✓</span>' : ''}
            ${c.contact.ownerBadge ? '<span class="owner-badge">👑</span>' : ''}
          </div>
          <div class="chat-last">@${c.contact.username}</div>
        </div>
        <button class="btn-secondary message-contact" data-user-id="${c.contact._id}">Message</button>
      </div>
    `).join('');
    document.querySelectorAll('.message-contact').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigateToChat(btn.dataset.userId);
      });
    });
  } catch (err) { showPopup(err.message, 'error'); }
}

function attachChatItemListeners() {
  document.querySelectorAll('.chat-item[data-chat-id]').forEach(item => {
    item.addEventListener('click', () => openChat(item.dataset.userId, item.dataset.chatId));
  });
  document.querySelectorAll('.chat-item[data-group-id]').forEach(item => {
    item.addEventListener('click', () => openGroup(item.dataset.groupId));
  });
}

async function openChat(otherUserId, chatId) {
  if (!otherUserId) return;
  currentChatUser = otherUserId;
  currentGroup = null;
  activeChatId = chatId;
  activeGroupId = null;

  document.getElementById('chats-list-container').classList.add('hidden');
  document.getElementById('chat-window').classList.remove('hidden');

  if (!chatId) {
    const chats = await apiRequest('/api/chats');
    const found = chats.find(c => c.otherUser?._id === otherUserId);
    if (found) {
      activeChatId = found._id;
    } else {
      activeChatId = null;
    }
  }

  if (activeChatId) {
    const msgs = await apiRequest(`/api/chats/${activeChatId}/messages`);
    renderMessages(msgs, 'chat');
  } else {
    document.getElementById('chat-messages').innerHTML = '';
  }

  const otherUser = await apiRequest(`/api/users/${otherUserId}`);
  document.getElementById('chat-header').innerHTML = `
    <img src="${otherUser.profilePic || 'https://via.placeholder.com/40'}" style="width:40px; height:40px; border-radius:50%; margin-right:10px;">
    <div>
      <strong>${otherUser.name}</strong>
      ${otherUser.verified ? '<span class="verified-badge">✓</span>' : ''}
      ${otherUser.ownerBadge ? '<span class="owner-badge">👑</span>' : ''}
    </div>
  `;
  document.getElementById('send-chat').onclick = sendPrivateMessage;
  document.getElementById('chat-input').onkeypress = (e) => {
    if (e.key === 'Enter') sendPrivateMessage();
  };
}

async function openGroup(groupId) {
  if (!groupId) return;
  currentGroup = groupId;
  currentChatUser = null;
  activeGroupId = groupId;
  activeChatId = null;

  document.getElementById('chats-list-container').classList.add('hidden');
  document.getElementById('chat-window').classList.remove('hidden');

  const msgs = await apiRequest(`/api/groups/${groupId}/messages`);
  renderMessages(msgs, 'group');

  socket.emit('join group', groupId);

  const group = await apiRequest(`/api/groups/${groupId}`);
  document.getElementById('chat-header').innerHTML = `
    <img src="${group.dp || 'https://via.placeholder.com/40'}" style="width:40px; height:40px; border-radius:50%; margin-right:10px;">
    <div>
      <strong>${group.name}</strong>
      ${group.admins?.includes(currentUser._id) ? ' (Admin)' : ''}
    </div>
    <button class="btn-icon" id="group-settings-btn"><i class="fas fa-cog"></i></button>
  `;
  document.getElementById('group-settings-btn').addEventListener('click', () => openGroupSettings(group));
  document.getElementById('send-chat').onclick = sendGroupMessage;
  document.getElementById('chat-input').onkeypress = (e) => {
    if (e.key === 'Enter') sendGroupMessage();
  };
}

function renderMessages(messages, type) {
  const container = document.getElementById('chat-messages');
  let lastDate = '';
  container.innerHTML = messages.map(m => {
    const isOwn = m.sender._id === currentUser._id;
    const dateHeader = formatDateHeader(m.createdAt);
    let headerHtml = '';
    if (dateHeader !== lastDate) {
      headerHtml = `<div class="date-separator">${dateHeader}</div>`;
      lastDate = dateHeader;
    }
    const timeStr = formatExactTime(m.createdAt);
    return headerHtml + `
      <div class="message ${isOwn ? 'own' : ''}">
        ${!isOwn && type === 'group' ? `<img src="${m.sender.profilePic || 'https://via.placeholder.com/20'}" style="width:20px; height:20px; border-radius:50%; margin-right:5px;">` : ''}
        ${!isOwn && type === 'group' ? `<strong>${m.sender.name}</strong> ` : ''}
        ${m.content}
        ${m.media && m.media.length ? `<img src="${m.media[0].url}" style="max-width:150px; border-radius:10px; display:block;">` : ''}
        <span class="message-time">${timeStr}</span>
        ${isOwn ? `<span class="message-status">${m.readBy?.length > 1 ? '✓✓' : '✓'}</span>` : ''}
      </div>
    `;
  }).join('');
  container.scrollTop = container.scrollHeight;
}

async function sendPrivateMessage() {
  const text = document.getElementById('chat-input').value.trim();
  const media = chatMediaBase64 ? [{ url: chatMediaBase64, type: 'image' }] : [];
  if (!text && media.length === 0) return;

  socket.emit('private message', { to: currentChatUser, content: text, media });

  document.getElementById('chat-input').value = '';
  chatMediaBase64 = null;

  const container = document.getElementById('chat-messages');
  container.innerHTML += `
    <div class="message own">
      ${text}
      ${media.length ? `<img src="${media[0].url}" style="max-width:150px; border-radius:10px; display:block;">` : ''}
      <span class="message-time">${formatExactTime(new Date())}</span>
      <span class="message-status">✓</span>
    </div>
  `;
  container.scrollTop = container.scrollHeight;
}

async function sendGroupMessage() {
  const text = document.getElementById('chat-input').value.trim();
  const media = chatMediaBase64 ? [{ url: chatMediaBase64, type: 'image' }] : [];
  if (!text && media.length === 0) return;

  socket.emit('group message', { groupId: currentGroup, content: text, media });

  document.getElementById('chat-input').value = '';
  chatMediaBase64 = null;

  const container = document.getElementById('chat-messages');
  container.innerHTML += `
    <div class="message own">
      ${text}
      ${media.length ? `<img src="${media[0].url}" style="max-width:150px; border-radius:10px; display:block;">` : ''}
      <span class="message-time">${formatExactTime(new Date())}</span>
      <span class="message-status">✓</span>
    </div>
  `;
  container.scrollTop = container.scrollHeight;
}

function handleIncomingPrivateMessage(data) {
  if (currentChatUser && data.from === currentChatUser) {
    const container = document.getElementById('chat-messages');
    container.innerHTML += `
      <div class="message">
        <img src="${data.fromAvatar || 'https://via.placeholder.com/20'}" style="width:20px; height:20px; border-radius:50%; margin-right:5px;">
        <strong>${data.fromName}</strong> ${data.content}
        ${data.media && data.media.length ? `<img src="${data.media[0].url}" style="max-width:150px; border-radius:10px; display:block;">` : ''}
        <span class="message-time">${formatExactTime(data.createdAt)}</span>
      </div>
    `;
    container.scrollTop = container.scrollHeight;
  } else {
    if (document.getElementById('chats-view')?.classList.contains('active') && currentChatTab === 'all') {
      loadAllChats();
    }
  }
}

function handleIncomingGroupMessage(data) {
  if (currentGroup && data.groupId === currentGroup) {
    const container = document.getElementById('chat-messages');
    container.innerHTML += `
      <div class="message">
        <img src="${data.fromAvatar || 'https://via.placeholder.com/20'}" style="width:20px; height:20px; border-radius:50%; margin-right:5px;">
        <strong>${data.fromName}</strong> ${data.content}
        ${data.media && data.media.length ? `<img src="${data.media[0].url}" style="max-width:150px; border-radius:10px; display:block;">` : ''}
        <span class="message-time">${formatExactTime(data.createdAt)}</span>
      </div>
    `;
    container.scrollTop = container.scrollHeight;
  } else {
    if (document.getElementById('chats-view')?.classList.contains('active') && (currentChatTab === 'all' || currentChatTab === 'groups')) {
      if (currentChatTab === 'all') loadAllChats();
      else loadGroupsList();
    }
  }
}

// Group settings
async function openGroupSettings(group) {
  const modal = document.getElementById('group-settings-modal');
  const details = document.getElementById('group-details');
  const membersList = document.getElementById('group-members-list');
  const isAdmin = group.admins.includes(currentUser._id);
  const isOwner = group.owner._id === currentUser._id;

  details.innerHTML = `
    <p><strong>Group:</strong> ${group.name}</p>
    <p><strong>Owner:</strong> ${group.owner.name}</p>
  `;

  membersList.innerHTML = '<h4>Members</h4>';
  group.members.forEach(member => {
    const memberIsAdmin = group.admins.includes(member._id);
    membersList.innerHTML += `
      <div class="user-item">
        <img src="${member.profilePic || 'https://via.placeholder.com/40'}" width="30">
        <span>${member.name} ${memberIsAdmin ? '(Admin)' : ''}</span>
        ${isAdmin && member._id !== currentUser._id ? `
          <button class="btn-secondary promote-admin" data-user-id="${member._id}">Make Admin</button>
          <button class="btn-danger remove-member" data-user-id="${member._id}">Remove</button>
        ` : ''}
        ${isOwner && memberIsAdmin && member._id !== currentUser._id ? `
          <button class="btn-secondary demote-admin" data-user-id="${member._id}">Remove Admin</button>
        ` : ''}
      </div>
    `;
  });

  if (isOwner) {
    membersList.innerHTML += `<button class="btn-danger" id="delete-group">Delete Group</button>`;
  }

  modal.classList.add('active');

  // Add event listeners for admin actions
  document.querySelectorAll('.promote-admin').forEach(btn => {
    btn.addEventListener('click', async () => {
      const userId = btn.dataset.userId;
      try {
        await apiRequest(`/api/groups/${group._id}/admins`, {
          method: 'POST',
          body: JSON.stringify({ userId })
        });
        showPopup('User promoted to admin', 'success');
        modal.classList.remove('active');
        openGroup(group._id);
      } catch (err) {
        showPopup(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('.demote-admin').forEach(btn => {
    btn.addEventListener('click', async () => {
      const userId = btn.dataset.userId;
      try {
        await apiRequest(`/api/groups/${group._id}/admins/${userId}`, { method: 'DELETE' });
        showPopup('Admin demoted', 'success');
        modal.classList.remove('active');
        openGroup(group._id);
      } catch (err) {
        showPopup(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('.remove-member').forEach(btn => {
    btn.addEventListener('click', async () => {
      const userId = btn.dataset.userId;
      showPopup('Enter reason for removal:', 'confirm', async (confirmed) => {
        if (confirmed) {
          const reason = prompt('Reason:'); // Simple, can be improved with custom popup
          try {
            await apiRequest(`/api/groups/${group._id}/members/${userId}`, {
              method: 'DELETE',
              body: JSON.stringify({ reason })
            });
            showPopup('Member removed', 'success');
            modal.classList.remove('active');
            openGroup(group._id);
          } catch (err) {
            showPopup(err.message, 'error');
          }
        }
      });
    });
  });

  document.getElementById('delete-group')?.addEventListener('click', async () => {
    showPopup('Delete this group permanently?', 'confirm', async (confirmed) => {
      if (confirmed) {
        try {
          await apiRequest(`/api/groups/${group._id}`, { method: 'DELETE' });
          showPopup('Group deleted', 'success');
          modal.classList.remove('active');
          loadView('chats');
        } catch (err) {
          showPopup(err.message, 'error');
        }
      }
    });
  });
}

async function generateInviteLink() {
  if (!currentGroup) return;
  try {
    const data = await apiRequest(`/api/groups/${currentGroup}/invite`, { method: 'POST' });
    document.getElementById('invite-link').value = data.inviteLink;
    document.getElementById('invite-link-container').classList.remove('hidden');
  } catch (err) {
    showPopup(err.message, 'error');
  }
}

// ==================== Navigation Helpers ====================
async function navigateToChat(userId) {
  await loadView('chats');
  setTimeout(() => openChat(userId, null), 300);
}

function openProfile(userId) {
  loadView('profile', userId);
}

// Make functions global for onclick attributes
window.openProfile = openProfile;
