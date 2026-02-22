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
let historyStack = [];

// DOM Elements (cached after login)
let loadingEl, authContainer, mainContainer, contentArea, bottomNavItems, fabCreate;

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

// Default avatar generator
function getAvatarHtml(user, size = 40) {
  if (user.profilePic) {
    return `<img src="${user.profilePic}" class="avatar" style="width:${size}px; height:${size}px;">`;
  } else {
    const initial = user.name ? user.name.charAt(0).toUpperCase() : '?';
    return `<div class="default-avatar" style="width:${size}px; height:${size}px; background: var(--primary); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold;">${initial}</div>`;
  }
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

// ==================== Back Button Handling ====================
window.addEventListener('popstate', (event) => {
  if (historyStack.length > 1) {
    historyStack.pop();
    const prevState = historyStack[historyStack.length - 1];
    if (prevState.view === 'chat' && prevState.chatId) {
      openChat(prevState.userId, prevState.chatId, false);
    } else if (prevState.view === 'group' && prevState.groupId) {
      openGroup(prevState.groupId, false);
    } else {
      loadView(prevState.view, prevState.param, false);
    }
  } else {
    // If at root, maybe exit app? For web, we can show a popup
    showPopup('Press back again to exit', 'info');
    // Push a dummy state to allow second back to exit
    history.pushState({ view: 'dummy' }, '');
  }
});

function pushHistory(view, param, chatId, groupId) {
  const state = { view, param, chatId, groupId };
  historyStack.push(state);
  history.pushState(state, '');
}

// ==================== Initialization ====================
document.addEventListener('DOMContentLoaded', async () => {
  loadingEl = document.getElementById('loading');
  authContainer = document.getElementById('auth-container');
  mainContainer = document.getElementById('main-container');
  contentArea = document.getElementById('content-area');
  bottomNavItems = document.querySelectorAll('.nav-item');
  fabCreate = document.getElementById('fab-create');

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

  window.logout = () => {
    setToken(null);
    window.location.reload();
  };

  window.showAbout = () => {
    document.getElementById('about-modal').classList.add('active');
  };

  window.openCreateGroup = () => {
    document.getElementById('new-chat-modal').classList.remove('active');
    document.getElementById('create-group-modal').classList.add('active');
    loadContactsForGroup();
  };

  window.openAddContact = () => {
    document.getElementById('new-chat-modal').classList.remove('active');
    document.getElementById('add-contact-modal').classList.add('active');
  };

  document.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));
    });
  });

  // Edit profile modal save
  document.getElementById('save-profile')?.addEventListener('click', saveProfile);
  document.getElementById('change-pic-btn')?.addEventListener('click', () => {
    document.getElementById('edit-dp').click();
  });
  document.getElementById('edit-dp')?.addEventListener('change', handleEditDp);
  document.getElementById('delete-account-btn')?.addEventListener('click', deleteAccount);

  // Group settings
  document.getElementById('generate-invite')?.addEventListener('click', generateInviteLink);
  document.getElementById('update-group')?.addEventListener('click', updateGroup);
  document.getElementById('copy-invite')?.addEventListener('click', copyInviteLink);

  // FAB click
  fabCreate?.addEventListener('click', () => {
    document.getElementById('create-post-modal').classList.add('active');
  });

  // Create post modal
  document.getElementById('attach-media').addEventListener('click', () => {
    document.getElementById('post-media').click();
  });
  document.getElementById('post-media').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        document.getElementById('post-media-preview').innerHTML = `<img src="${reader.result}" style="max-width:100px; border-radius:10px;">`;
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
      document.getElementById('post-media-preview').innerHTML = '';
      delete window.postMediaBase64;
      unsavedChanges = false;
      showPopup('Post created!', 'success');
      document.getElementById('create-post-modal').classList.remove('active');
      loadView('feed');
    } catch (err) {
      showPopup(err.message, 'error');
    } finally {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  });
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
  socket.on('message deleted', handleMessageDeleted);
  socket.on('message read', handleMessageRead);
  socket.on('new notification', handleNewNotification);
  socket.on('system notification', (data) => {
    showPopup(`🔊 ${data.from}: ${data.message}`, 'info');
  });

  bottomNavItems.forEach(item => {
    item.addEventListener('click', () => {
      bottomNavItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      const view = item.dataset.view;
      loadView(view);
      // Hide FAB on non-feed views
      if (view === 'feed') fabCreate.classList.remove('hidden');
      else fabCreate.classList.add('hidden');
    });
  });

  loadView('feed');
  pushHistory('feed');

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

async function loadView(view, param, addToHistory = true) {
  contentArea.innerHTML = '';
  unsavedChanges = false;
  if (view === 'feed') {
    await renderFeed();
    fabCreate.classList.remove('hidden');
  } else if (view === 'search') {
    renderSearch();
    fabCreate.classList.add('hidden');
  } else if (view === 'notifications') {
    await renderNotifications();
    fabCreate.classList.add('hidden');
  } else if (view === 'chats') {
    await renderChats();
    fabCreate.classList.add('hidden');
  } else if (view === 'profile') {
    await renderProfile(param || currentUser._id);
    fabCreate.classList.add('hidden');
  }
  if (addToHistory) pushHistory(view, param);
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
          <img src="${s.user.profilePic || ''}" onerror="this.style.display='none'; this.parentNode.innerHTML='<div class=\\'default-avatar\\' style=\\'width:60px;height:60px;background:var(--primary);border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:bold;\\'>${s.user.name.charAt(0).toUpperCase()}</div>';">
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
  document.getElementById('story-likes').textContent = story.viewers.length;
  const likeBtn = document.getElementById('like-story');
  const deleteBtn = document.getElementById('delete-story');
  
  likeBtn.classList.toggle('liked', story.viewers.includes(currentUser._id));
  likeBtn.onclick = async () => {
    try {
      const data = await apiRequest(`/api/stories/${story._id}/like`, { method: 'POST' });
      document.getElementById('story-likes').textContent = data.viewers.length;
      likeBtn.classList.toggle('liked');
    } catch (err) {
      showPopup(err.message, 'error');
    }
  };
  
  deleteBtn.onclick = async () => {
    if (story.user._id !== currentUser._id) return showPopup('You can only delete your own stories', 'warning');
    showPopup('Delete this story?', 'confirm', async (confirmed) => {
      if (confirmed) {
        try {
          await apiRequest(`/api/stories/${story._id}`, { method: 'DELETE' });
          modal.classList.remove('active');
          loadView('feed');
        } catch (err) {
          showPopup(err.message, 'error');
        }
      }
    });
  };
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
        ${post.user.profilePic 
          ? `<img src="${post.user.profilePic}" class="post-avatar">` 
          : `<div class="default-avatar post-avatar" style="background:var(--primary);">${post.user.name.charAt(0).toUpperCase()}</div>`}
        <div>
          <div class="post-user">
            ${post.user.name}
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
        ${c.user.profilePic 
          ? `<img src="${c.user.profilePic}" class="comment-avatar" style="width:30px;height:30px;border-radius:50%;">` 
          : `<div class="default-avatar" style="width:30px;height:30px;background:var(--primary);border-radius:50%;display:flex;align-items:center;justify-content:center;">${c.user.name.charAt(0).toUpperCase()}</div>`}
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
      ${u.profilePic 
        ? `<img src="${u.profilePic}">` 
        : `<div class="default-avatar" style="width:50px;height:50px;background:var(--primary);border-radius:50%;display:flex;align-items:center;justify-content:center;">${u.name.charAt(0).toUpperCase()}</div>`}
      <div class="user-info">
        <h4>
          ${u.name}
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

// ==================== Notifications ====================
async function renderNotifications() {
  contentArea.innerHTML = `
    <div class="view active" id="notifications-view">
      <div id="notifications-container"></div>
    </div>
  `;
  await loadNotifications();
}

async function loadNotifications() {
  try {
    const notifications = await apiRequest('/api/notifications');
    const container = document.getElementById('notifications-container');
    if (notifications.length === 0) {
      container.innerHTML = '<p class="text-secondary">No notifications</p>';
      return;
    }
    container.innerHTML = notifications.map(n => `
      <div class="notification-item ${n.read ? '' : 'unread'}" data-notification-id="${n._id}" data-type="${n.type}" data-from="${n.from?._id}" data-post="${n.post?._id}" data-group="${n.group?._id}">
        ${n.from?.profilePic 
          ? `<img src="${n.from.profilePic}">` 
          : `<div class="default-avatar" style="width:40px;height:40px;background:var(--primary);border-radius:50%;display:flex;align-items:center;justify-content:center;">${n.from?.name?.charAt(0).toUpperCase() || '?'}</div>`}
        <div class="notification-content">
          <div class="notification-text">${n.message}</div>
          <div class="notification-time">${formatTime(n.createdAt)}</div>
        </div>
      </div>
    `).join('');
    document.querySelectorAll('.notification-item').forEach(item => {
      item.addEventListener('click', async () => {
        const id = item.dataset.notificationId;
        await apiRequest(`/api/notifications/${id}/read`, { method: 'POST' });
        item.classList.remove('unread');
        if (item.dataset.type === 'follow') {
          openProfile(item.dataset.from);
        } else if (item.dataset.type === 'like' || item.dataset.type === 'comment') {
          // load post modal (simplified)
          showPopup('View post feature coming soon', 'info');
        } else if (item.dataset.type === 'message') {
          navigateToChat(item.dataset.from);
        } else if (item.dataset.type === 'group_message' || item.dataset.type === 'group_add' || item.dataset.type === 'group_admin') {
          loadView('chats');
          // open group later
        }
        document.getElementById('notifications-modal').classList.remove('active');
      });
    });
  } catch (err) {
    showPopup(err.message, 'error');
  }
}

function handleNewNotification(data) {
  if (document.getElementById('notifications-view')?.classList.contains('active')) {
    loadNotifications();
  }
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
          <div style="position: relative;">
            ${user.profilePic 
              ? `<img src="${user.profilePic}" class="profile-avatar">` 
              : `<div class="default-avatar profile-avatar" style="background:var(--primary);">${user.name.charAt(0).toUpperCase()}</div>`}
            ${isOwn ? `<i class="fas fa-cog settings-icon" onclick="document.getElementById('settings-modal').classList.add('active')"></i>` : ''}
          </div>
          <div>
            <h3>
              ${user.name}
              ${user.verified ? '<span class="verified-badge">✓</span>' : ''}
              ${user.ownerBadge ? '<span class="owner-badge">👑</span>' : ''}
            </h3>
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
              <div class="stat">
                <div class="stat-number">${user.postsCount || 0}</div>
                <div class="stat-label">Posts</div>
              </div>
            </div>
            ${!isOwn ? `<button class="follow-btn btn-primary" data-user-id="${userId}">${user.isFollowing ? 'Unfollow' : 'Follow'}</button>` : ''}
            ${!isOwn ? `<button class="add-contact-btn btn-secondary" data-user-id="${userId}"><i class="fas fa-user-plus"></i> Add Contact</button>` : ''}
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
              ${s.profilePic 
                ? `<img src="${s.profilePic}">` 
                : `<div class="default-avatar" style="width:60px;height:60px;background:var(--primary);border-radius:50%;display:flex;align-items:center;justify-content:center;">${s.name.charAt(0).toUpperCase()}</div>`}
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
      document.querySelector('.add-contact-btn').addEventListener('click', async () => {
        document.getElementById('contact-ssn').value = user.ssn;
        document.getElementById('add-contact-modal').classList.add('active');
      });
    } else {
      // Edit profile button is now the gear icon, but we already have settings icon
      // The gear icon opens settings modal, which contains edit profile option
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
        ${u.profilePic 
          ? `<img src="${u.profilePic}">` 
          : `<div class="default-avatar" style="width:50px;height:50px;background:var(--primary);border-radius:50%;display:flex;align-items:center;justify-content:center;">${u.name.charAt(0).toUpperCase()}</div>`}
        <div class="user-info">
          <h4>
            ${u.name}
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
  document.getElementById('edit-profile-pic').src = currentUser.profilePic || '';
  modal.classList.add('active');
}

function handleEditDp(e) {
  const file = e.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = () => {
      editDpBase64 = reader.result;
      document.getElementById('edit-profile-pic').src = reader.result;
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
      <div class="chats-header">
        <h3>Chats</h3>
        <button id="new-chat-btn"><i class="fas fa-plus"></i></button>
      </div>
      <div class="chats-tabs">
        <button class="chat-tab ${currentChatTab === 'all' ? 'active' : ''}" data-tab="all">All</button>
        <button class="chat-tab ${currentChatTab === 'contacts' ? 'active' : ''}" data-tab="contacts">Contacts</button>
        <button class="chat-tab ${currentChatTab === 'groups' ? 'active' : ''}" data-tab="groups">Groups</button>
      </div>
      <div id="chats-list-container">
        <div class="chats-list" id="chats-list"></div>
      </div>
      <div class="chat-window hidden" id="chat-window">
        <div class="chat-header" id="chat-header">
          <button class="btn-icon" id="back-from-chat"><i class="fas fa-arrow-left"></i></button>
          <div id="chat-header-info"></div>
        </div>
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

  document.getElementById('new-chat-btn').addEventListener('click', () => {
    document.getElementById('new-chat-modal').classList.add('active');
  });

  document.getElementById('back-from-chat').addEventListener('click', () => {
    // Go back to chats list
    document.getElementById('chat-window').classList.add('hidden');
    document.getElementById('chats-list-container').classList.remove('hidden');
    currentChatUser = null;
    currentGroup = null;
    activeChatId = null;
    activeGroupId = null;
    // Update history
    historyStack.pop(); // remove chat state
    loadView('chats', null, false);
  });

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
            ${item.otherUser?.profilePic 
              ? `<img src="${item.otherUser.profilePic}">` 
              : `<div class="default-avatar" style="width:50px;height:50px;background:var(--primary);border-radius:50%;display:flex;align-items:center;justify-content:center;">${item.otherUser?.name?.charAt(0).toUpperCase() || '?'}</div>`}
            <div class="chat-info">
              <div class="chat-name">
                ${item.otherUser?.name || 'Unknown'}
                ${item.otherUser?.verified ? '<span class="verified-badge">✓</span>' : ''}
                ${item.otherUser?.ownerBadge ? '<span class="owner-badge">👑</span>' : ''}
              </div>
              <div class="chat-last">${item.lastMessage?.content || 'No messages'}</div>
            </div>
            <div class="chat-time">${item.lastMessage ? formatTime(item.lastMessage.createdAt) : ''}</div>
            ${item.unreadCount ? `<span class="unread-badge">${item.unreadCount}</span>` : ''}
          </div>
        `;
      } else {
        return `
          <div class="chat-item" data-group-id="${item._id}" data-type="group">
            ${item.dp 
              ? `<img src="${item.dp}">` 
              : `<div class="default-avatar" style="width:50px;height:50px;background:var(--primary);border-radius:50%;display:flex;align-items:center;justify-content:center;">${item.name.charAt(0).toUpperCase()}</div>`}
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
        ${g.dp 
          ? `<img src="${g.dp}">` 
          : `<div class="default-avatar" style="width:50px;height:50px;background:var(--primary);border-radius:50%;display:flex;align-items:center;justify-content:center;">${g.name.charAt(0).toUpperCase()}</div>`}
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
        ${c.contact.profilePic 
          ? `<img src="${c.contact.profilePic}">` 
          : `<div class="default-avatar" style="width:50px;height:50px;background:var(--primary);border-radius:50%;display:flex;align-items:center;justify-content:center;">${c.contact.name.charAt(0).toUpperCase()}</div>`}
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

async function openChat(otherUserId, chatId, addToHistory = true) {
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
  document.getElementById('chat-header-info').innerHTML = `
    ${otherUser.profilePic 
      ? `<img src="${otherUser.profilePic}" style="width:40px;height:40px;border-radius:50%;">` 
      : `<div class="default-avatar" style="width:40px;height:40px;background:var(--primary);border-radius:50%;display:flex;align-items:center;justify-content:center;">${otherUser.name.charAt(0).toUpperCase()}</div>`}
    <div>
      <strong>${otherUser.name}</strong>
      ${otherUser.verified ? '<span class="verified-badge">✓</span>' : ''}
      ${otherUser.ownerBadge ? '<span class="owner-badge">👑</span>' : ''}
    </div>
  `;
  documet.getElementById('send-chat').onclick = sendPrivateMessage;
  document.getElementById('chat-input').onkeypress = (e) => {
    if (e.key === 'Enter') sendPrivateMessage();
  };

  if (addToHistory) pushHistory('chat', otherUserId, activeChatId);
}

async function openGroup(groupId, addToHistory = true) {
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
  document.getElementById('chat-header-info').innerHTML = `
    ${group.dp 
      ? `<img src="${group.dp}" style="width:40px;height:40px;border-radius:50%;">` 
      : `<div class="default-avatar" style="width:40px;height:40px;background:var(--primary);border-radius:50%;display:flex;align-items:center;justify-content:center;">${group.name.charAt(0).toUpperCase()}</div>`}
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

  if (addToHistory) pushHistory('group', groupId, null, groupId);
}

function renderMessages(messages, type) {
  const container = document.getElementById('chat-messages');
  let lastDate = '';
  container.innerHTML = messages.map(m => {
    const isOwn = m.sender._id === currentUser._id;
    const dateHeader = formatDateHeader(m.createdAt);
    let headerHtml = '';
    if (dateHeader !== lastDate) {
      headerHtml = `<div class="date-separator" style="text-align:center;color:var(--text-secondary);margin:10px 0;">${dateHeader}</div>`;
      lastDate = dateHeader;
    }
    const timeStr = formatExactTime(m.createdAt);
    return headerHtml + `
      <div class="message ${isOwn ? 'own' : ''}" data-message-id="${m._id}">
        ${!isOwn && type === 'group' ? (m.sender.profilePic ? `<img src="${m.sender.profilePic}" style="width:20px;height:20px;border-radius:50%;margin-right:5px;">` : `<div class="default-avatar" style="width:20px;height:20px;background:var(--primary);border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:10px;">${m.sender.name.charAt(0).toUpperCase()}</div>`) : ''}
        ${!isOwn && type === 'group' ? `<strong>${m.sender.name}</strong> ` : ''}
        ${m.content}
        ${m.media && m.media.length ? `<img src="${m.media[0].url}" style="max-width:150px;border-radius:10px;display:block;">` : ''}
        <span class="message-time">${timeStr}</span>
        ${isOwn ? `<span class="message-status">${m.readBy?.length > 1 ? '✓✓' : '✓'}</span>` : ''}
        ${(isOwn || (type === 'group' && (currentGroup && (group?.admins?.includes(currentUser._id) || group?.owner?._id === currentUser._id)))) ? 
          `<button class="delete-message" onclick="deleteMessage('${m._id}')"><i class="fas fa-trash"></i></button>` : ''}
      </div>
    `;
  }).join('');
  container.scrollTop = container.scrollHeight;
}

async function deleteMessage(messageId) {
  showPopup('Delete this message?', 'confirm', async (confirmed) => {
    if (confirmed) {
      try {
        await apiRequest(`/api/messages/${messageId}`, { method: 'DELETE' });
        // Message will be removed via socket event
      } catch (err) {
        showPopup(err.message, 'error');
      }
    }
  });
}

function handleMessageDeleted(data) {
  const msgEl = document.querySelector(`.message[data-message-id="${data.messageId}"]`);
  if (msgEl) msgEl.remove();
}

function handleMessageRead(data) {
  const msgEl = document.querySelector(`.message[data-message-id="${data.messageId}"] .message-status`);
  if (msgEl) msgEl.textContent = '✓✓';
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
      ${media.length ? `<img src="${media[0].url}" style="max-width:150px;border-radius:10px;display:block;">` : ''}
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
      ${media.length ? `<img src="${media[0].url}" style="max-width:150px;border-radius:10px;display:block;">` : ''}
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
        ${data.fromAvatar ? `<img src="${data.fromAvatar}" style="width:20px;height:20px;border-radius:50%;margin-right:5px;">` : `<div class="default-avatar" style="width:20px;height:20px;background:var(--primary);border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:10px;">${data.fromName.charAt(0).toUpperCase()}</div>`}
        <strong>${data.fromName}</strong> ${data.content}
        ${data.media && data.media.length ? `<img src="${data.media[0].url}" style="max-width:150px;border-radius:10px;display:block;">` : ''}
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
        ${data.fromAvatar ? `<img src="${data.fromAvatar}" style="width:20px;height:20px;border-radius:50%;margin-right:5px;">` : `<div class="default-avatar" style="width:20px;height:20px;background:var(--primary);border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:10px;">${data.fromName.charAt(0).toUpperCase()}</div>`}
        <strong>${data.fromName}</strong> ${data.content}
        ${data.media && data.media.length ? `<img src="${data.media[0].url}" style="max-width:150px;border-radius:10px;display:block;">` : ''}
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
let currentGroupObj = null;
let groupDpBase64 = '';

async function openGroupSettings(group) {
  currentGroupObj = group;
  const modal = document.getElementById('group-settings-modal');
  const details = document.getElementById('group-details');
  const membersList = document.getElementById('group-members-list');
  const isAdmin = group.admins.includes(currentUser._id);
  const isOwner = group.owner._id === currentUser._id;

  details.innerHTML = `
    <p><strong>Group:</strong> ${group.name}</p>
    <p><strong>Owner:</strong> ${group.owner.name}</p>
  `;

  document.getElementById('group-name-edit').value = group.name;
  document.getElementById('group-dp-preview').innerHTML = group.dp ? `<img src="${group.dp}" width="50">` : '';

  membersList.innerHTML = '<h4>Members</h4>';
  group.members.forEach(member => {
    const memberIsAdmin = group.admins.includes(member._id);
    membersList.innerHTML += `
      <div class="user-item">
        ${member.profilePic ? `<img src="${member.profilePic}" width="30">` : `<div class="default-avatar" style="width:30px;height:30px;background:var(--primary);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;">${member.name.charAt(0).toUpperCase()}</div>`}
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
        openGroup(group._id, false);
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
        openGroup(group._id, false);
      } catch (err) {
        showPopup(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('.remove-member').forEach(btn => {
    btn.addEventListener('click', async () => {
      const userId = btn.dataset.userId;
      const reason = prompt('Enter reason for removal:');
      if (reason === null) return;
      try {
        await apiRequest(`/api/groups/${group._id}/members/${userId}`, {
          method: 'DELETE',
          body: JSON.stringify({ reason })
        });
        showPopup('Member removed', 'success');
        modal.classList.remove('active');
        openGroup(group._id, false);
      } catch (err) {
        showPopup(err.message, 'error');
      }
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

async function updateGroup() {
  const name = document.getElementById('group-name-edit').value.trim();
  const dp = groupDpBase64;
  if (!name && !dp) return showPopup('No changes', 'warning');
  try {
    const updates = {};
    if (name && name !== currentGroupObj.name) updates.name = name;
    if (dp) updates.dp = dp;
    await apiRequest(`/api/groups/${currentGroupObj._id}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    });
    showPopup('Group updated', 'success');
    document.getElementById('group-settings-modal').classList.remove('active');
    openGroup(currentGroupObj._id, false);
  } catch (err) {
    showPopup(err.message, 'error');
  }
}

document.getElementById('group-dp')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = () => {
      groupDpBase64 = reader.result;
      document.getElementById('group-dp-preview').innerHTML = `<img src="${reader.result}" width="50">`;
    };
    reader.readAsDataURL(file);
  }
});

async function generateInviteLink() {
  if (!currentGroupObj) return;
  try {
    const data = await apiRequest(`/api/groups/${currentGroupObj._id}/invite`, { method: 'POST' });
    document.getElementById('invite-link').value = data.inviteLink;
    document.getElementById('invite-link-container').classList.remove('hidden');
  } catch (err) {
    showPopup(err.message, 'error');
  }
}

function copyInviteLink() {
  const link = document.getElementById('invite-link');
  link.select();
  navigator.clipboard.writeText(link.value);
  showPopup('Invite link copied!', 'success');
}

async function loadContactsForGroup() {
  try {
    const contacts = await apiRequest('/api/contacts');
    const container = document.getElementById('contact-select-list');
    container.innerHTML = contacts.map(c => `
      <div>
        <input type="checkbox" id="contact-${c.contact._id}" value="${c.contact._id}">
        <label for="contact-${c.contact._id}">${c.nickname || c.contact.name}</label>
      </div>
    `).join('');
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
window.deleteMessage = deleteMessage;
window.openEditProfileModal = openEditProfileModal;
    
