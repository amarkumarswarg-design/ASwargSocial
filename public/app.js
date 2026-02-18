// ==================== Configuration & State ====================
let socket = null;
let currentUser = null;
let currentChatUser = null;
let activeChatId = null;

// DOM Elements
const loadingEl = document.getElementById('loading');
const authContainer = document.getElementById('auth-container');
const mainContainer = document.getElementById('main-container');
const contentArea = document.getElementById('content-area');

// ==================== Helper: API Request ====================
async function apiRequest(endpoint, options = {}) {
  const token = localStorage.getItem('token');
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  
  const res = await fetch(endpoint, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ==================== Auth Logic ====================
async function initApp() {
  const token = localStorage.getItem('token');
  if (!token) return showAuth();

  try {
    loadingEl.classList.remove('hidden');
    // Profile Race Condition Fix: Pehle data lao, phir app dikhao
    currentUser = await apiRequest('/api/auth/me');
    showMainApp();
    
    // Connect Socket
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

// ==================== View Router (No more loops!) ====================
async function loadView(view, param = null) {
  contentArea.innerHTML = '<div class="spinner"></div>'; // Loading state
  
  switch(view) {
    case 'feed': await renderFeed(); break;
    case 'search': renderSearch(); break;
    case 'create': renderCreate(); break;
    case 'chats': await renderChats(); break;
    case 'profile': await renderProfile(param || currentUser._id); break;
  }
  
  // Update Bottom Nav UI
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.view === view);
  });
}

// ==================== Profile Logic (Fixed Blank Screen) ====================
async function renderProfile(userId) {
  try {
    const user = await apiRequest(`/api/users/${userId}`);
    const isOwn = user._id === currentUser._id;

    contentArea.innerHTML = `
      <div class="profile-header glass-card">
        <img src="${user.profilePic || 'default-avatar.png'}" class="profile-avatar">
        <div class="profile-info">
          <h3>${user.name}</h3>
          <p class="text-secondary">@${user.username}</p>
          <p class="ssn-badge">${user.ssn}</p>
          <div class="stats-row">
            <div class="stat" onclick="showFollowers('${user._id}')"><b>${user.followersCount}</b> Followers</div>
            <div class="stat" onclick="showFollowing('${user._id}')"><b>${user.followingCount}</b> Following</div>
          </div>
          ${!isOwn ? `<button class="btn-primary mt-2" onclick="toggleFollow('${user._id}', this)">${user.isFollowing ? 'Unfollow' : 'Follow'}</button>` : ''}
        </div>
      </div>
      <div id="user-posts" class="mt-4"></div>
    `;
    // Fetch and render posts...
  } catch (err) { contentArea.innerHTML = `<p class="error">User not found</p>`; }
}

// ==================== Messaging (Real-time Fix) ====================
async function navigateToChat(userId) {
  await loadView('chats');
  // DOM ke ready hone ka intezar karein
  const checkInterval = setInterval(() => {
    if (document.getElementById('chat-window')) {
      clearInterval(checkInterval);
      openChatWindow(userId);
    }
  }, 50);
}

function openChatWindow(userId) {
  currentChatUser = userId;
  document.getElementById('chats-list').classList.add('hidden');
  document.getElementById('chat-window').classList.remove('hidden');
  document.getElementById('chat-messages').innerHTML = ''; // Clear old msgs
  // Load message history from API...
}

function sendMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !currentChatUser) return;

  // Real-time Socket Emit
  socket.emit('private message', { to: currentChatUser, content: text });
  
  // UI Update (Optimistic)
  appendMessage({ from: currentUser._id, content: text, createdAt: new Date() });
  input.value = '';
}

function handleIncomingMessage(data) {
  if (currentChatUser === data.from) {
    appendMessage(data);
  } else {
    // Show notification badge
    alert(`New message from ${data.from}`);
  }
}

function appendMessage(data) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${data.from === currentUser._id ? 'own' : 'other'}`;
  msgDiv.innerHTML = `<p>${data.content}</p><span class="time">${new Date(data.createdAt).toLocaleTimeString()}</span>`;
  const container = document.getElementById('chat-messages');
  container.appendChild(msgDiv);
  container.scrollTop = container.scrollHeight;
}

// Initialize on Load
document.addEventListener('DOMContentLoaded', initApp);

// Global Exposure for HTML onclicks
window.openProfile = (id) => loadView('profile', id);
window.navigateToChat = navigateToChat;
window.toggleFollow = async (id, btn) => { /* Follow logic */ };
