// ==================== Configuration & State ====================
let socket = null;
let currentUser = null;
let currentChatUser = null;

// DOM Elements
const loadingEl = document.getElementById('loading');
const authContainer = document.getElementById('auth-container');
const mainContainer = document.getElementById('main-container');
const contentArea = document.getElementById('content-area');

// ==================== Helper: API & Token ====================
async function apiRequest(endpoint, options = {}) {
  const token = localStorage.getItem('token');
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  
  const res = await fetch(endpoint, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ==================== Initialization ====================
async function initApp() {
  const token = localStorage.getItem('token');
  if (!token) return showAuth();

  try {
    loadingEl.classList.remove('hidden');
    // Fix: Ensure user data is loaded before anything else
    currentUser = await apiRequest('/api/auth/me');
    showMainApp();
    
    socket = io({ auth: { token } });
    socket.on('private message', handleIncomingMessage);
    
    loadView('feed');
  } catch (err) {
    localStorage.removeItem('token');
    showAuth();
  } finally {
    loadingEl.classList.add('hidden');
  }
}

function showMainApp() {
  authContainer.classList.add('hidden');
  mainContainer.classList.remove('hidden');
}

function showAuth() {
  authContainer.classList.remove('hidden');
  mainContainer.classList.add('hidden');
}

// ==================== Navigation Router ====================
async function loadView(view, param = null) {
  contentArea.innerHTML = '<div class="spinner"></div>';
  
  // Highlight active nav item
  document.querySelectorAll('.nav-item').forEach(i => {
    i.classList.toggle('active', i.dataset.view === view);
  });

  if (view === 'feed') await renderFeed();
  else if (view === 'search') renderSearch();
  else if (view === 'create') renderCreate();
  else if (view === 'chats') await renderChats();
  else if (view === 'profile') await renderProfile(param || currentUser._id);
}

// ==================== Feed & Posts ====================
async function renderFeed() {
  try {
    const posts = await apiRequest('/api/posts/feed');
    contentArea.innerHTML = posts.length ? posts.map(p => createPostHTML(p)).join('') : '<p class="empty">No posts yet.</p>';
  } catch (err) { console.error(err); }
}

function createPostHTML(post) {
  const isLiked = post.likes.includes(currentUser._id);
  return `
    <div class="post-card glass-card">
      <div class="post-header" onclick="openProfile('${post.user._id}')">
        <img src="${post.user.profilePic || 'default-avatar.png'}" class="avatar">
        <div><strong>${post.user.name}</strong><p>@${post.user.username}</p></div>
      </div>
      <div class="post-body">
        <p>${post.content || ''}</p>
        ${post.media.map(m => `<img src="${m.url}" class="post-img">`).join('')}
      </div>
      <div class="post-footer">
        <button onclick="likePost('${post._id}', this)" class="${isLiked ? 'liked' : ''}">
          <i class="fa-heart ${isLiked ? 'fas' : 'far'}"></i> ${post.likes.length}
        </button>
        <button onclick="openComments('${post._id}')"><i class="far fa-comment"></i> ${post.comments.length}</button>
      </div>
    </div>
  `;
}

// ==================== Messaging (Fixed Loop & Logic) ====================
async function navigateToChat(userId) {
  await loadView('chats');
  // Small delay to ensure DOM is ready
  setTimeout(() => openChatWindow(userId), 100);
}

async function openChatWindow(userId) {
  currentChatUser = userId;
  document.getElementById('chats-list').classList.add('hidden');
  document.getElementById('chat-window').classList.remove('hidden');
  
  // Fetch chat history from server
  const container = document.getElementById('chat-messages');
  container.innerHTML = '<p class="loading-text">Loading history...</p>';
  // Logic to fetch and render messages goes here...
}

function sendMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !currentChatUser) return;

  // Single source: Socket only
  socket.emit('private message', { to: currentChatUser, content: text });
  
  appendMessage({ from: currentUser._id, content: text, createdAt: new Date() });
  input.value = '';
}

function handleIncomingMessage(data) {
  if (currentChatUser === data.from) {
    appendMessage(data);
  } else {
    // Simple notification for background messages
    console.log("New message from:", data.from);
  }
}

function appendMessage(data) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `message ${data.from === currentUser._id ? 'own' : 'other'}`;
  div.innerHTML = `<p>${data.content}</p><span>${new Date(data.createdAt).toLocaleTimeString()}</span>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ==================== Event Listeners ====================
document.addEventListener('DOMContentLoaded', initApp);

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => loadView(item.dataset.view));
});

// Global functions for HTML
window.openProfile = (id) => loadView('profile', id);
window.navigateToChat = navigateToChat;
          
