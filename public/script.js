// ==================== Configuration ====================
const API_BASE = ''; // empty means relative to current origin (same domain)
let socket = null;
let currentUser = null;
let currentChatUser = null;
let cropper = null;

// DOM Elements
const loadingEl = document.getElementById('loading');
const authContainer = document.getElementById('auth-container');
const mainContainer = document.getElementById('main-container');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const tabBtns = document.querySelectorAll('.tab-btn');
const loginMessage = document.getElementById('login-message');
const registerMessage = document.getElementById('register-message');
const ssnDisplay = document.getElementById('ssn-display');
const ssnValue = document.getElementById('ssn-value');
const copySsnBtn = document.getElementById('copy-ssn');
const logoutBtn = document.getElementById('logout-btn');
const navItems = document.querySelectorAll('.nav-item');
const views = document.querySelectorAll('.view');

// Feed elements
const postContent = document.getElementById('post-content');
const submitPost = document.getElementById('submit-post');
const postMediaBtn = document.getElementById('post-media-btn');
const postMediaInput = document.getElementById('post-media-input');
const feedPosts = document.getElementById('feed-posts');

// Search
const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');

// Chats
const chatsList = document.getElementById('chats-list');
const chatArea = document.getElementById('chat-area');
const chatHeader = document.getElementById('chat-header');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendChatBtn = document.getElementById('send-chat-btn');

// Profile
const profilePic = document.getElementById('profile-pic');
const profileName = document.getElementById('profile-name');
const profileUsername = document.getElementById('profile-username');
const profileSsn = document.getElementById('profile-ssn');
const followersCount = document.getElementById('followers-count');
const followingCount = document.getElementById('following-count');
const followBtn = document.getElementById('follow-btn');
const profilePosts = document.getElementById('profile-posts');

// Settings
const settingsName = document.getElementById('settings-name');
const settingsUsername = document.getElementById('settings-username');
const settingsPassword = document.getElementById('settings-password');
const settingsDp = document.getElementById('settings-dp');
const settingsDpPreview = document.getElementById('settings-dp-preview');
const saveSettingsBtn = document.getElementById('save-settings');
const deletePassword = document.getElementById('delete-password');
const deleteAccountBtn = document.getElementById('delete-account-btn');

// Register DP
const regDpInput = document.getElementById('reg-dp');
const dpPreviewContainer = document.getElementById('dp-preview-container');
const dpPreview = document.getElementById('dp-preview');
const cropBtn = document.getElementById('crop-btn');

// ==================== Helper Functions ====================
function showLoading() {
  loadingEl.classList.remove('hidden');
}
function hideLoading() {
  loadingEl.classList.add('hidden');
}

function getToken() {
  return localStorage.getItem('token');
}

function setToken(token) {
  if (token) localStorage.setItem('token', token);
  else localStorage.removeItem('token');
}

function isLoggedIn() {
  return !!getToken();
}

async function apiRequest(endpoint, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

// ==================== Authentication UI ====================
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
    document.getElementById(`${tab}-form`).classList.add('active');
    ssnDisplay.classList.add('hidden');
  });
});

// Register with DP crop
regDpInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = () => {
      dpPreview.src = reader.result;
      dpPreviewContainer.classList.remove('hidden');
      if (cropper) cropper.destroy();
      cropper = new Cropper(dpPreview, {
        aspectRatio: 1,
        viewMode: 1,
        autoCropArea: 1,
      });
    };
    reader.readAsDataURL(file);
  }
});

cropBtn.addEventListener('click', () => {
  if (cropper) {
    const canvas = cropper.getCroppedCanvas({ width: 500, height: 500 });
    canvas.toBlob(async (blob) => {
      // Upload to Cloudinary via backend? Actually we'll do direct unsigned upload from frontend for simplicity.
      // But we need Cloudinary config. For now, we'll convert to base64 and send to backend which then uploads.
      // Simpler: convert to base64 and send to registration endpoint.
      const reader = new FileReader();
      reader.readAsDataURL(blob);
      reader.onload = () => {
        // Store base64 in a hidden field or data attribute.
        // We'll use a global variable.
        window.regDpBase64 = reader.result;
        alert('Image cropped and ready. Complete registration.');
      };
    }, 'image/jpeg');
  }
});

// Register form submit
registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('reg-name').value;
  const username = document.getElementById('reg-username').value;
  const password = document.getElementById('reg-password').value;
  let profilePic = '';
  let profilePicPublicId = '';
  
  if (window.regDpBase64) {
    // Upload to Cloudinary (you'd need to implement a backend endpoint that uses Cloudinary upload)
    // For demo, we'll assume backend accepts base64 and handles upload.
    // We'll send base64 in profilePic field; backend will process.
    profilePic = window.regDpBase64;
  }

  try {
    showLoading();
    const data = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, username, password, profilePic })
    });
    setToken(data.token);
    currentUser = data.user;
    registerMessage.style.color = 'green';
    registerMessage.textContent = 'Registration successful!';
    // Show SSN
    ssnValue.textContent = data.user.ssn;
    ssnDisplay.classList.remove('hidden');
    // Auto login after 2 sec
    setTimeout(() => {
      window.location.reload(); // or switch to main
    }, 2000);
  } catch (err) {
    registerMessage.style.color = 'red';
    registerMessage.textContent = err.message;
  } finally {
    hideLoading();
  }
});

// Login form submit
loginForm.addEventListener('submit', async (e) => {
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
    // Switch to main UI
    authContainer.classList.add('hidden');
    mainContainer.classList.remove('hidden');
    initializeApp();
  } catch (err) {
    loginMessage.style.color = 'red';
    loginMessage.textContent = err.message;
  } finally {
    hideLoading();
  }
});

// Copy SSN
copySsnBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(ssnValue.textContent);
  alert('SSN copied to clipboard!');
});

// Logout
logoutBtn.addEventListener('click', () => {
  setToken(null);
  window.location.reload();
});

// ==================== App Initialization ====================
async function initializeApp() {
  if (!currentUser) {
    try {
      currentUser = await apiRequest('/api/auth/me');
    } catch (err) {
      setToken(null);
      authContainer.classList.remove('hidden');
      mainContainer.classList.add('hidden');
      return;
    }
  }

  // Connect Socket.io
  socket = io({ auth: { token: getToken() } });
  socket.on('connect', () => console.log('Socket connected'));
  socket.on('private message', handleIncomingMessage);
  socket.on('system notification', (data) => {
    alert(`System: ${data.message}`);
  });

  // Load initial data
  loadFeed();
  loadChatsList();

  // Set up navigation
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      const viewName = item.dataset.view;
      views.forEach(v => v.classList.remove('active'));
      document.getElementById(`${viewName}-view`).classList.add('active');
      
      if (viewName === 'profile') loadMyProfile();
      if (viewName === 'settings') loadSettings();
    });
  });

  // Post creation
  submitPost.addEventListener('click', createPost);
  postMediaBtn.addEventListener('click', () => postMediaInput.click());

  // Search
  searchInput.addEventListener('input', debounce(handleSearch, 500));

  // Chat
  sendChatBtn.addEventListener('click', sendChatMessage);
  chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendChatMessage();
  });

  // Follow button
  followBtn.addEventListener('click', toggleFollow);

  // Settings save
  saveSettingsBtn.addEventListener('click', saveSettings);
  deleteAccountBtn.addEventListener('click', deleteAccount);
}

function debounce(func, delay) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => func.apply(this, args), delay);
  };
}

// ==================== Feed ====================
async function loadFeed() {
  try {
    const posts = await apiRequest('/api/posts/feed?page=1');
    renderPosts(posts, feedPosts);
  } catch (err) {
    console.error('Failed to load feed', err);
  }
}

function renderPosts(posts, container) {
  container.innerHTML = '';
  posts.forEach(post => {
    const postEl = document.createElement('div');
    postEl.className = 'post-card glass';
    postEl.innerHTML = `
      <div class="post-header">
        <img src="${post.user.profilePic || 'https://via.placeholder.com/40'}" class="post-avatar">
        <div>
          <div class="post-user">${post.user.name} (@${post.user.username})</div>
          <div class="post-time">${new Date(post.createdAt).toLocaleString()}</div>
        </div>
      </div>
      <div class="post-content">${post.content || ''}</div>
      ${post.media.map(m => m.type === 'image' ? `<img src="${m.url}" class="post-media">` : '').join('')}
      <div class="post-actions-row">
        <button class="like-btn" data-post-id="${post._id}"><i class="fas fa-heart"></i> ${post.likes.length}</button>
        <button class="comment-toggle" data-post-id="${post._id}"><i class="fas fa-comment"></i> ${post.comments.length}</button>
      </div>
      <div class="comments-section" id="comments-${post._id}" style="display: none;">
        ${post.comments.map(c => `
          <div class="comment">
            <span class="comment-user">@${c.user.username}:</span>
            <span>${c.text}</span>
            ${c.user._id === currentUser._id ? `<button class="delete-comment" data-comment-id="${c._id}" data-post-id="${post._id}"><i class="fas fa-trash"></i></button>` : ''}
          </div>
        `).join('')}
        <input type="text" class="comment-input" placeholder="Write a comment..." data-post-id="${post._id}">
      </div>
    `;
    container.appendChild(postEl);
  });

  // Attach event listeners for likes, comments, etc.
  document.querySelectorAll('.like-btn').forEach(btn => {
    btn.addEventListener('click', toggleLike);
  });
  document.querySelectorAll('.comment-toggle').forEach(btn => {
    btn.addEventListener('click', toggleComments);
  });
  document.querySelectorAll('.comment-input').forEach(input => {
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') addComment(e.target.dataset.postId, e.target.value);
    });
  });
  document.querySelectorAll('.delete-comment').forEach(btn => {
    btn.addEventListener('click', deleteComment);
  });
}

async function toggleLike(e) {
  const postId = e.currentTarget.dataset.postId;
  try {
    const data = await apiRequest(`/api/posts/${postId}/like`, { method: 'PUT' });
    e.currentTarget.innerHTML = `<i class="fas fa-heart"></i> ${data.likes.length}`;
  } catch (err) {
    console.error(err);
  }
}

function toggleComments(e) {
  const postId = e.currentTarget.dataset.postId;
  const section = document.getElementById(`comments-${postId}`);
  section.style.display = section.style.display === 'none' ? 'block' : 'none';
}

async function addComment(postId, text) {
  if (!text.trim()) return;
  try {
    await apiRequest(`/api/posts/${postId}/comment`, {
      method: 'POST',
      body: JSON.stringify({ text })
    });
    // Reload comments or just update UI (simplified: reload feed)
    loadFeed();
  } catch (err) {
    console.error(err);
  }
}

async function deleteComment(e) {
  const postId = e.currentTarget.dataset.postId;
  const commentId = e.currentTarget.dataset.commentId;
  try {
    await apiRequest(`/api/posts/${postId}/comment/${commentId}`, { method: 'DELETE' });
    loadFeed();
  } catch (err) {
    console.error(err);
  }
}

async function createPost() {
  const content = postContent.value;
  const media = []; // handle media upload later
  if (!content && media.length === 0) return;

  try {
    await apiRequest('/api/posts', {
      method: 'POST',
      body: JSON.stringify({ content, media })
    });
    postContent.value = '';
    loadFeed();
  } catch (err) {
    alert(err.message);
  }
}

// ==================== Search ====================
async function handleSearch() {
  const query = searchInput.value.trim();
  if (query.length < 2) {
    searchResults.innerHTML = '';
    return;
  }
  try {
    const users = await apiRequest(`/api/users/search?q=${encodeURIComponent(query)}`);
    searchResults.innerHTML = users.map(u => `
      <div class="user-result" data-user-id="${u._id}" data-username="${u.username}">
        <img src="${u.profilePic || 'https://via.placeholder.com/50'}" alt="avatar">
        <div class="user-result-info">
          <h4>${u.name}</h4>
          <p>@${u.username} · ${u.ssn}</p>
        </div>
      </div>
    `).join('');
    document.querySelectorAll('.user-result').forEach(el => {
      el.addEventListener('click', () => openChat(el.dataset.userId, el.dataset.username));
    });
  } catch (err) {
    console.error(err);
  }
}

// ==================== Chats ====================
function openChat(userId, username) {
  currentChatUser = { _id: userId, username };
  chatHeader.innerHTML = `<strong>${username}</strong>`;
  chatMessages.innerHTML = '';
  // Load messages (you'd need a backend endpoint for chat history)
  // For now, simulate
  chatInput.disabled = false;
  sendChatBtn.disabled = false;
}

function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text || !currentChatUser) return;
  // Emit via socket
  socket.emit('private message', { to: currentChatUser._id, content: text, media: [] });
  // Add to UI
  const msgDiv = document.createElement('div');
  msgDiv.className = 'message own';
  msgDiv.textContent = text;
  chatMessages.appendChild(msgDiv);
  chatInput.value = '';
}

function handleIncomingMessage(data) {
  if (currentChatUser && data.from === currentChatUser._id) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message';
    msgDiv.textContent = data.content;
    chatMessages.appendChild(msgDiv);
  } else {
    // Show notification maybe
    console.log('Message from', data.from);
  }
}

async function loadChatsList() {
  // Implement later
}

// ==================== Profile ====================
async function loadMyProfile() {
  if (!currentUser) return;
  profilePic.src = currentUser.profilePic || 'https://via.placeholder.com/120';
  profileName.textContent = currentUser.name;
  profileUsername.textContent = `@${currentUser.username}`;
  profileSsn.textContent = currentUser.ssn;
  // Load followers count etc. (implement later)
  // Load user's posts
  const posts = await apiRequest(`/api/posts/user/${currentUser._id}`);
  renderPosts(posts, profilePosts);
}

async function toggleFollow() {
  // Implement later
}

// ==================== Settings ====================
function loadSettings() {
  settingsName.value = currentUser.name;
  settingsUsername.value = currentUser.username;
  settingsPassword.value = '';
  settingsDpPreview.innerHTML = currentUser.profilePic ? `<img src="${currentUser.profilePic}" width="50">` : '';
}

async function saveSettings() {
  const updates = {};
  if (settingsName.value !== currentUser.name) updates.name = settingsName.value;
  if (settingsUsername.value !== currentUser.username) updates.username = settingsUsername.value;
  if (settingsPassword.value) updates.password = settingsPassword.value;
  // Handle DP change (if file selected) - similar to registration
  try {
    const data = await apiRequest('/api/users/me', {
      method: 'PUT',
      body: JSON.stringify(updates)
    });
    currentUser = data;
    alert('Settings updated');
  } catch (err) {
    alert(err.message);
  }
}

async function deleteAccount() {
  const password = deletePassword.value;
  if (!password) return alert('Enter your password');
  if (!confirm('This will permanently delete your account and all data. Are you sure?')) return;
  try {
    await apiRequest('/api/users/me', {
      method: 'DELETE',
      body: JSON.stringify({ password })
    });
    setToken(null);
    window.location.reload();
  } catch (err) {
    alert(err.message);
  }
}

// ==================== Initial Check ====================
if (isLoggedIn()) {
  authContainer.classList.add('hidden');
  mainContainer.classList.remove('hidden');
  initializeApp();
} else {
  authContainer.classList.remove('hidden');
  mainContainer.classList.add('hidden');
  }
