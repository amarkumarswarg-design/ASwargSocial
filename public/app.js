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
let currentStoryIndex = 0;
let stories = [];

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

  // Auth UI tabs
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

  // Register DP crop
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
          alert('Image cropped. Complete registration.');
        };
      }, 'image/jpeg');
    }
  });

  // Register submit
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
      setTimeout(() => window.location.reload(), 2000);
    } catch (err) {
      document.getElementById('register-message').style.color = 'red';
      document.getElementById('register-message').textContent = err.message;
    } finally {
      hideLoading();
    }
  });

  // Login submit
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
      initApp();
    } catch (err) {
      document.getElementById('login-message').style.color = 'red';
      document.getElementById('login-message').textContent = err.message;
    } finally {
      hideLoading();
    }
  });

  // Copy SSN
  document.getElementById('copy-ssn').addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('ssn-value').textContent);
    alert('SSN copied!');
  });

  // Logout
  headerLogout?.addEventListener('click', () => {
    setToken(null);
    window.location.reload();
  });

  // Close modals
  document.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));
    });
  });
});

function showAuth() {
  authContainer.classList.remove('hidden');
  mainContainer.classList.add('hidden');
}

function initApp() {
  // Connect socket
  socket = io({ auth: { token: getToken() } });
  socket.on('connect', () => console.log('Socket connected'));
  socket.on('private message', handleIncomingPrivateMessage);
  socket.on('group message', handleIncomingGroupMessage);
  socket.on('system notification', (data) => {
    alert(`🔊 ${data.from}: ${data.message}`);
  });

  // Bottom navigation
  bottomNavItems.forEach(item => {
    item.addEventListener('click', () => {
      bottomNavItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      loadView(item.dataset.view);
    });
  });

  // Load feed by default
  loadView('feed');

  // If bot, add broadcast button
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
        alert('Broadcast sent!');
        document.getElementById('bot-modal').classList.remove('active');
        document.getElementById('broadcast-message').value = '';
      } catch (err) {
        alert(err.message);
      }
    });
  }

  // Add contact modal
  document.getElementById('save-contact').addEventListener('click', async () => {
    const ssn = document.getElementById('contact-ssn').value.trim();
    const nickname = document.getElementById('contact-nickname').value.trim();
    if (!ssn) return alert('Enter SSN');
    try {
      await apiRequest('/api/contacts', {
        method: 'POST',
        body: JSON.stringify({ contactSsn: ssn, nickname })
      });
      document.getElementById('add-contact-modal').classList.remove('active');
      document.getElementById('contact-ssn').value = '';
      document.getElementById('contact-nickname').value = '';
      alert('Contact added');
      if (document.getElementById('chats-view')?.classList.contains('active')) {
        loadView('chats');
      }
    } catch (err) {
      alert(err.message);
    }
  });

  // Create group modal
  document.getElementById('create-group-btn').addEventListener('click', async () => {
    const name = document.getElementById('group-name').value.trim();
    if (!name) return alert('Enter group name');
    const selected = document.querySelectorAll('#contact-select-list input:checked');
    const members = Array.from(selected).map(cb => cb.value);
    try {
      await apiRequest('/api/groups', {
        method: 'POST',
        body: JSON.stringify({ name, members })
      });
      document.getElementById('create-group-modal').classList.remove('active');
      document.getElementById('group-name').value = '';
      alert('Group created');
      loadView('chats');
    } catch (err) {
      alert(err.message);
    }
  });
}

// ==================== View Router ====================
async function loadView(view, param) {
  contentArea.innerHTML = '';
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
    stories = await apiRequest('/api/stories/feed');
    const container = document.getElementById('story-row');
    container.innerHTML = `
      <div class="story-item add-story" id="add-story-btn">
        <div class="story-avatar">
          <i class="fas fa-plus"></i>
        </div>
        <span class="story-name">Add</span>
      </div>
    ` + stories.map(s => `
      <div class="story-item" data-story-id="${s._id}">
        <div class="story-avatar">
          <img src="${s.user.profilePic || 'https://via.placeholder.com/60'}" alt="">
        </div>
        <span class="story-name">${s.user.username}</span>
      </div>
    `).join('');

    document.getElementById('add-story-btn').addEventListener('click', () => {
      // Open story upload (simplified: just alert for now)
      alert('Story upload not implemented in demo');
    });

    document.querySelectorAll('.story-item[data-story-id]').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.dataset.storyId;
        const story = stories.find(s => s._id === id);
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
  return `
    <div class="post-card" data-post-id="${post._id}">
      <div class="post-header" onclick="openProfile('${post.user._id}')">
        <img src="${post.user.profilePic || 'https://via.placeholder.com/40'}" class="post-avatar">
        <div>
          <div class="post-user">${post.user.name} @${post.user.username}</div>
          <div class="post-time">${formatTime(post.createdAt)}</div>
        </div>
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
      } catch (err) { console.error(err); }
    });
  });

  document.querySelectorAll('.comment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentPostId = btn.dataset.postId;
      loadCommentsModal(currentPostId);
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
  } catch (err) { console.error(err); }
}

// ==================== Search ====================
function renderSearch() {
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
}

async function handleSearch() {
  const query = document.getElementById('search-input').value.trim();
  if (query.length < 2) return;
  try {
    const users = await apiRequest(`/api/users/search?q=${encodeURIComponent(query)}`);
    const resultsDiv = document.getElementById('search-results');
    resultsDiv.innerHTML = users.map(u => `
      <div class="user-item" data-user-id="${u._id}">
        <img src="${u.profilePic || 'https://via.placeholder.com/50'}">
        <div class="user-info">
          <h4>${u.name}</h4>
          <p>@${u.username} · ${u.ssn}</p>
        </div>
        <button class="follow-btn btn-secondary" data-user-id="${u._id}">${u.isFollowing ? 'Unfollow' : 'Follow'}</button>
        <button class="chat-btn btn-primary" data-user-id="${u._id}"><i class="fas fa-comment"></i></button>
        <button class="add-contact-btn btn-secondary" data-user-id="${u._id}"><i class="fas fa-user-plus"></i></button>
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

    document.querySelectorAll('.add-contact-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const userId = btn.dataset.userId;
        // For demo, just alert; could open contact modal prefilled
        alert('Add contact feature: would need SSN. Use Contacts section.');
      });
    });
  } catch (err) { console.error(err); }
}

// ==================== Create Post ====================
function renderCreate() {
  contentArea.innerHTML = `
    <div class="view active" id="create-view">
      <div class="create-post-card glass-card">
        <textarea id="post-content" placeholder="What's on your mind?" rows="3"></textarea>
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
      };
      reader.readAsDataURL(file);
    }
  });

  document.getElementById('submit-post').addEventListener('click', async () => {
    const content = document.getElementById('post-content').value;
    const mediaBase64 = window.postMediaBase64;
    if (!content && !mediaBase64) return;
    const media = mediaBase64 ? [{ url: mediaBase64, type: 'image' }] : [];
    try {
      await apiRequest('/api/posts', { method: 'POST', body: JSON.stringify({ content, media }) });
      document.getElementById('post-content').value = '';
      document.getElementById('media-preview').innerHTML = '';
      delete window.postMediaBase64;
      alert('Post created!');
      loadView('feed');
    } catch (err) { alert(err.message); }
  });
}

// ==================== Profile ====================
async function renderProfile(userId) {
  if (!currentUser) {
    try {
      currentUser = await apiRequest('/api/auth/me');
    } catch (err) {
      console.error('Failed to fetch current user');
      return;
    }
  }
  const isOwn = userId === currentUser._id;
  try {
    const user = await apiRequest(`/api/users/${userId}`);
    const posts = await apiRequest(`/api/posts/user/${userId}`);

    const profileHtml = `
      <div class="view active" id="profile-view">
        <div class="profile-header glass-card">
          <img src="${user.profilePic || 'https://via.placeholder.com/80'}" class="profile-avatar">
          <div>
            <h3>${user.name}</h3>
            <p>@${user.username}</p>
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
          </div>
        </div>
        <div id="profile-posts" class="profile-posts">
          ${posts.map(p => renderPost(p)).join('')}
        </div>
        ${isOwn ? `
        <div class="settings-card glass-card">
          <h3>Account Settings</h3>
          <div class="setting-item">
            <label>Name</label>
            <input type="text" id="settings-name" value="${user.name}">
          </div>
          <div class="setting-item">
            <label>Username</label>
            <input type="text" id="settings-username" value="${user.username}">
          </div>
          <div class="setting-item">
            <label>New Password (leave blank to keep current)</label>
            <input type="password" id="settings-password">
          </div>
          <div class="setting-item">
            <label>Profile Picture</label>
            <input type="file" id="settings-dp" accept="image/*">
            <div id="settings-dp-preview" class="preview-small"></div>
          </div>
          <button id="save-settings" class="btn-primary">Save Changes</button>
          <hr>
          <div class="danger-zone">
            <h4>Delete Account</h4>
            <p>This action is permanent. Enter your password to confirm.</p>
            <input type="password" id="delete-password" placeholder="Your password">
            <button id="delete-account-btn" class="btn-danger">Delete My Account</button>
          </div>
          <hr>
          <div class="creator-credit">
            <p><i class="fas fa-crown"></i> Creator: Amar Kumar</p>
          </div>
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
      // Settings listeners
      document.getElementById('save-settings').addEventListener('click', saveSettings);
      document.getElementById('delete-account-btn').addEventListener('click', deleteAccount);
      document.getElementById('settings-dp').addEventListener('change', handleSettingsDp);
    }

    document.getElementById('followers-stat').addEventListener('click', () => showFollowList(userId, 'followers'));
    document.getElementById('following-stat').addEventListener('click', () => showFollowList(userId, 'following'));

  } catch (err) { console.error(err); }
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
  } catch (err) { alert(err.message); }
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
          <h4>${u.name}</h4>
          <p>@${u.username}</p>
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
  } catch (err) { console.error(err); }
}

// Settings helpers
let settingsDpBase64 = '';
function handleSettingsDp(e) {
  const file = e.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = () => {
      settingsDpBase64 = reader.result;
      document.getElementById('settings-dp-preview').innerHTML = `<img src="${reader.result}" width="50" style="border-radius:10px;">`;
    };
    reader.readAsDataURL(file);
  }
}

async function saveSettings() {
  const updates = {};
  const name = document.getElementById('settings-name').value;
  if (name !== currentUser.name) updates.name = name;
  const username = document.getElementById('settings-username').value;
  if (username !== currentUser.username) updates.username = username;
  const password = document.getElementById('settings-password').value;
  if (password) updates.password = password;
  if (settingsDpBase64) updates.profilePic = settingsDpBase64;

  try {
    const data = await apiRequest('/api/users/me', {
      method: 'PUT',
      body: JSON.stringify(updates)
    });
    currentUser = data;
    alert('Settings updated');
    loadView('profile', currentUser._id);
  } catch (err) { alert(err.message); }
}

async function deleteAccount() {
  const password = document.getElementById('delete-password').value;
  if (!password) return alert('Enter your password');
  if (!confirm('This will permanently delete your account. Are you sure?')) return;
  try {
    await apiRequest('/api/users/me', {
      method: 'DELETE',
      body: JSON.stringify({ password })
    });
    setToken(null);
    window.location.reload();
  } catch (err) { alert(err.message); }
}

// ==================== Chats (Dual Pane) ====================
async function renderChats() {
  contentArea.innerHTML = `
    <div class="view active" id="chats-view">
      <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
        <button class="btn-secondary" id="show-contacts"><i class="fas fa-address-book"></i> Contacts</button>
        <button class="btn-secondary" id="show-groups"><i class="fas fa-users"></i> Groups</button>
        <button class="btn-primary" id="new-group"><i class="fas fa-plus"></i> Group</button>
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
        </div>
      </div>
    </div>
  `;

  document.getElementById('show-contacts').addEventListener('click', loadContactsList);
  document.getElementById('show-groups').addEventListener('click', loadGroupsList);
  document.getElementById('new-group').addEventListener('click', openCreateGroupModal);

  await loadChatsList();
}

async function loadChatsList() {
  try {
    const chats = await apiRequest('/api/chats');
    const list = document.getElementById('chats-list');
    list.innerHTML = chats.map(c => `
      <div class="chat-item" data-chat-id="${c._id}" data-user-id="${c.otherUser._id}" data-type="chat">
        <img src="${c.otherUser.profilePic || 'https://via.placeholder.com/50'}">
        <div class="chat-info">
          <div class="chat-name">${c.otherUser.name}</div>
          <div class="chat-last">${c.lastMessage?.content || 'No messages'}</div>
        </div>
        <div class="chat-time">${c.lastMessage ? formatTime(c.lastMessage.createdAt) : ''}</div>
      </div>
    `).join('');
    attachChatItemListeners();
  } catch (err) { console.error(err); }
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
  } catch (err) { console.error(err); }
}

async function loadContactsList() {
  try {
    const contacts = await apiRequest('/api/contacts');
    const list = document.getElementById('chats-list');
    list.innerHTML = contacts.map(c => `
      <div class="chat-item" data-user-id="${c.contact._id}" data-type="contact">
        <img src="${c.contact.profilePic || 'https://via.placeholder.com/50'}">
        <div class="chat-info">
          <div class="chat-name">${c.nickname || c.contact.name}</div>
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
  } catch (err) { console.error(err); }
}

function attachChatItemListeners() {
  document.querySelectorAll('.chat-item[data-chat-id]').forEach(item => {
    item.addEventListener('click', () => openChat(item.dataset.userId, item.dataset.chatId));
  });
  document.querySelectorAll('.chat-item[data-group-id]').forEach(item => {
    item.addEventListener('click', () => openGroup(item.dataset.groupId));
  });
}

function openCreateGroupModal() {
  // Load contacts for selection
  apiRequest('/api/contacts').then(contacts => {
    const container = document.getElementById('contact-select-list');
    container.innerHTML = contacts.map(c => `
      <div>
        <input type="checkbox" id="contact-${c.contact._id}" value="${c.contact._id}">
        <label for="contact-${c.contact._id}">${c.nickname || c.contact.name}</label>
      </div>
    `).join('');
    document.getElementById('create-group-modal').classList.add('active');
  }).catch(err => alert(err.message));
}

async function openChat(otherUserId, chatId) {
  currentChatUser = otherUserId;
  currentGroup = null;
  activeChatId = chatId;
  activeGroupId = null;

  document.getElementById('chats-list-container').classList.add('hidden');
  document.getElementById('chat-window').classList.remove('hidden');

  if (!chatId) {
    const chats = await apiRequest('/api/chats');
    const found = chats.find(c => c.otherUser._id === otherUserId);
    if (found) {
      activeChatId = found._id;
    } else {
      activeChatId = null;
    }
  }

  if (activeChatId) {
    const msgs = await apiRequest(`/api/chats/${activeChatId}/messages`);
    renderMessages(msgs);
  } else {
    document.getElementById('chat-messages').innerHTML = '';
  }

  document.getElementById('chat-header').innerHTML = `<strong>Chat</strong>`;
  document.getElementById('send-chat').onclick = sendPrivateMessage;
  document.getElementById('chat-input').onkeypress = (e) => {
    if (e.key === 'Enter') sendPrivateMessage();
  };
}

async function openGroup(groupId) {
  currentGroup = groupId;
  currentChatUser = null;
  activeGroupId = groupId;
  activeChatId = null;

  document.getElementById('chats-list-container').classList.add('hidden');
  document.getElementById('chat-window').classList.remove('hidden');

  const msgs = await apiRequest(`/api/groups/${groupId}/messages`);
  renderMessages(msgs);

  socket.emit('join group', groupId);

  const group = await apiRequest(`/api/groups/${groupId}`);
  document.getElementById('chat-header').innerHTML = `<strong>${group.name}</strong>`;
  document.getElementById('send-chat').onclick = sendGroupMessage;
  document.getElementById('chat-input').onkeypress = (e) => {
    if (e.key === 'Enter') sendGroupMessage();
  };
}

function renderMessages(messages) {
  const container = document.getElementById('chat-messages');
  container.innerHTML = messages.map(m => {
    const isOwn = m.sender === currentUser._id;
    return `
      <div class="message ${isOwn ? 'own' : ''}">
        ${!isOwn && m.senderName ? `<strong>${m.senderName}:</strong> ` : ''}
        ${m.content}
        <span class="message-time">${formatTime(m.createdAt)}</span>
        ${isOwn ? `<span class="message-status">${m.readBy?.length > 1 ? '✓✓' : '✓'}</span>` : ''}
      </div>
    `;
  }).join('');
  container.scrollTop = container.scrollHeight;
}

async function sendPrivateMessage() {
  const text = document.getElementById('chat-input').value.trim();
  if (!text || !currentChatUser) return;

  socket.emit('private message', { to: currentChatUser, content: text });

  const container = document.getElementById('chat-messages');
  container.innerHTML += `
    <div class="message own">
      ${text}
      <span class="message-time">${formatTime(new Date())}</span>
      <span class="message-status">✓</span>
    </div>
  `;
  container.scrollTop = container.scrollHeight;
  document.getElementById('chat-input').value = '';
}

async function sendGroupMessage() {
  const text = document.getElementById('chat-input').value.trim();
  if (!text || !currentGroup) return;

  socket.emit('group message', { groupId: currentGroup, content: text });

  const container = document.getElementById('chat-messages');
  container.innerHTML += `
    <div class="message own">
      ${text}
      <span class="message-time">${formatTime(new Date())}</span>
      <span class="message-status">✓</span>
    </div>
  `;
  container.scrollTop = container.scrollHeight;
  document.getElementById('chat-input').value = '';
}

function handleIncomingPrivateMessage(data) {
  if (currentChatUser && data.from === currentChatUser) {
    const container = document.getElementById('chat-messages');
    container.innerHTML += `
      <div class="message">
        ${data.content}
        <span class="message-time">${formatTime(data.createdAt)}</span>
      </div>
    `;
    container.scrollTop = container.scrollHeight;
  } else {
    if (document.getElementById('chats-view')?.classList.contains('active')) {
      loadChatsList();
    }
  }
}

function handleIncomingGroupMessage(data) {
  if (currentGroup && data.groupId === currentGroup) {
    const container = document.getElementById('chat-messages');
    container.innerHTML += `
      <div class="message">
        <strong>${data.fromName || 'User'}:</strong> ${data.content}
        <span class="message-time">${formatTime(data.createdAt)}</span>
      </div>
    `;
    container.scrollTop = container.scrollHeight;
  } else {
    if (document.getElementById('chats-view')?.classList.contains('active')) {
      loadGroupsList();
    }
  }
}

// ==================== Navigation Helpers ====================
async function navigateToChat(userId) {
  await loadView('chats');
  // Need to ensure chats list is loaded before opening
  setTimeout(() => openChat(userId, null), 300);
}

function openProfile(userId) {
  loadView('profile', userId);
}

// Make functions global for onclick attributes
window.openProfile = openProfile;
