// ==================== Configuration ====================
const API_BASE = ''; // relative to current origin
let socket = null;
let currentUser = null;
let currentChatUser = null;   // for chat window
let activeChatId = null;      // for loading messages
let cropper = null;
let currentPostId = null;     // for comments modal

// DOM elements (will be populated after auth)
let loadingEl, authContainer, mainContainer, contentArea, bottomNavItems;

// Helper functions
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

// Debounce utility
function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// ==================== Authentication & Initialization ====================
document.addEventListener('DOMContentLoaded', async () => {
  // Cache DOM elements
  loadingEl = document.getElementById('loading');
  authContainer = document.getElementById('auth-container');
  mainContainer = document.getElementById('main-container');
  contentArea = document.getElementById('content-area');
  bottomNavItems = document.querySelectorAll('.nav-item');

  // Check token
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

  // Auth UI event listeners
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

  // Register with image crop
  const regDp = document.getElementById('reg-dp');
  const dpPreviewContainer = document.getElementById('dp-preview-container');
  const dpPreview = document.getElementById('dp-preview');
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

  // Register form
  document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('reg-name').value;
    const username = document.getElementById('reg-username').value;
    const password = document.getElementById('reg-password').value;
    let profilePic = window.regDpBase64 || '';
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

  // Login form
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
  document.getElementById('logout-btn').addEventListener('click', () => {
    setToken(null);
    window.location.reload();
  });

  // Modal close buttons
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
  // Connect Socket.io
  socket = io({ auth: { token: getToken() } });
  socket.on('connect', () => console.log('Socket connected'));
  socket.on('private message', handleIncomingMessage);
  socket.on('system notification', (data) => {
    alert(`🔊 System: ${data.message}`);
  });

  // Setup bottom navigation
  bottomNavItems.forEach(item => {
    item.addEventListener('click', () => {
      bottomNavItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      const view = item.dataset.view;
      loadView(view);
    });
  });

  // Load default view (Feed)
  loadView('feed');

  // If user is bot, add bot button to header (for broadcast)
  if (currentUser?.isBot) {
    const header = document.querySelector('.app-header');
    const botBtn = document.createElement('button');
    botBtn.className = 'btn-icon';
    botBtn.innerHTML = '<i class="fas fa-robot"></i>';
    botBtn.onclick = () => document.getElementById('bot-modal').classList.add('active');
    header.appendChild(botBtn);

    // Broadcast send
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
}

// View router
async function loadView(view) {
  contentArea.innerHTML = ''; // clear
  if (view === 'feed') await renderFeed();
  else if (view === 'search') renderSearch();
  else if (view === 'create') renderCreate();
  else if (view === 'chats') await renderChats();
  else if (view === 'profile') await renderProfile(currentUser._id);
}

// ==================== Feed ====================
async function renderFeed() {
  const feedHtml = `
    <div class="view active" id="feed-view">
      <div id="feed-posts"></div>
    </div>
  `;
  contentArea.innerHTML = feedHtml;
  await loadFeedPosts();
}

async function loadFeedPosts() {
  try {
    const posts = await apiRequest('/api/posts/feed?page=1');
    const container = document.getElementById('feed-posts');
    container.innerHTML = posts.map(post => renderPost(post)).join('');
    attachPostListeners();
  } catch (err) {
    console.error(err);
  }
}

function renderPost(post) {
  const isLiked = post.likes.includes(currentUser._id);
  return `
    <div class="post-card" data-post-id="${post._id}">
      <div class="post-header">
        <img src="${post.user.profilePic || 'https://via.placeholder.com/40'}" class="post-avatar" onclick="viewProfile('${post.user._id}')">
        <div>
          <div class="post-user" onclick="viewProfile('${post.user._id}')">${post.user.name} @${post.user.username}</div>
          <div class="post-time">${new Date(post.createdAt).toLocaleString()}</div>
        </div>
      </div>
      <div class="post-content">${post.content || ''}</div>
      ${post.media.map(m => m.type === 'image' ? `<img src="${m.url}" class="post-media">` : '').join('')}
      <div class="post-actions">
        <button class="like-btn ${isLiked ? 'liked' : ''}" data-post-id="${post._id}">
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
        const countSpan = btn.querySelector('.like-count');
        countSpan.textContent = data.likes.length;
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

// ==================== Comments Modal ====================
async function loadCommentsModal(postId) {
  try {
    const post = await apiRequest(`/api/posts/${postId}`); // we need a GET /api/posts/:postId endpoint
    // For now, we can fetch comments from feed data or create a new endpoint.
    // We'll create a new endpoint later; but for demo, we'll reuse.
    // We'll just show comments from the post object.
    const comments = post.comments || [];
    const modal = document.getElementById('comments-modal');
    const list = document.getElementById('comments-list');
    list.innerHTML = comments.map(c => `
      <div class="comment-item">
        <img src="${c.user.profilePic || 'https://via.placeholder.com/30'}" class="comment-avatar">
        <div>
          <strong>@${c.user.username}</strong> ${c.text}
          <div class="comment-time">${new Date(c.createdAt).toLocaleString()}</div>
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
      loadCommentsModal(postId); // refresh
      // Also refresh feed comment count
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
  } catch (err) {
    console.error(err);
  }
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
      </div>
    `).join('');
    // Attach follow/unfollow and click to profile
    document.querySelectorAll('.user-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (!e.target.classList.contains('follow-btn')) {
          viewProfile(item.dataset.userId);
        }
      });
    });
    document.querySelectorAll('.follow-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const userId = btn.dataset.userId;
        await toggleFollow(userId, btn);
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
        const preview = document.getElementById('media-preview');
        preview.innerHTML = `<img src="${reader.result}" style="max-width:100px; border-radius:10px;">`;
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
      await apiRequest('/api/posts', {
        method: 'POST',
        body: JSON.stringify({ content, media })
      });
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
  const isOwn = userId === currentUser._id;
  try {
    const user = await apiRequest(`/api/users/${userId}`);
    const posts = await apiRequest(`/api/posts/user/${userId}`);
    const followersCount = user.followersCount || 0; // we'll need to add these fields
    const followingCount = user.followingCount || 0;
    const isFollowing = user.isFollowing || false;

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
                <div class="stat-number">${followersCount}</div>
                <div class="stat-label">Followers</div>
              </div>
              <div class="stat" id="following-stat">
                <div class="stat-number">${followingCount}</div>
                <div class="stat-label">Following</div>
              </div>
            </div>
            ${!isOwn ? `<button class="follow-btn btn-primary" data-user-id="${userId}">${isFollowing ? 'Unfollow' : 'Follow'}</button>` : ''}
          </div>
        </div>
        <div id="profile-posts" class="profile-posts">
          ${posts.map(p => renderPost(p)).join('')}
        </div>
      </div>
    `;
    contentArea.innerHTML = profileHtml;
    attachPostListeners();

    // Follow button
    if (!isOwn) {
      document.querySelector('.follow-btn').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        await toggleFollow(userId, btn);
      });
    }

    // Followers/Following click to show modal
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
    // Update counts in profile if visible
    // ...
  } catch (err) { alert(err.message); }
}

async function showFollowList(userId, type) {
  try {
    const users = await apiRequest(`/api/users/${userId}/${type}`);
    const modal = document.getElementById(`${type}-modal`);
    const list = document.getElementById(`${type}-list`);
    list.innerHTML = users.map(u => `
      <div class="user-item" data-user-id="${u._id}">
        <img src="${u.profilePic || 'https://via.placeh
