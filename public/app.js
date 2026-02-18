let currentUser = null;

async function initApp() {
  const token = localStorage.getItem('token');
  if (!token) return showView('auth');

  try {
    currentUser = await fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    }).then(res => res.json());
    
    showView('main');
    loadView('feed');
  } catch { showView('auth'); }
}

function showView(view) {
  const auth = document.getElementById('auth-container');
  const main = document.getElementById('main-container');
  
  if (view === 'auth') {
    auth.classList.remove('hidden');
    main.classList.add('hidden');
  } else {
    auth.classList.add('hidden');
    main.classList.remove('hidden');
  }
}

async function loadView(view) {
  const area = document.getElementById('content-area');
  area.innerHTML = '<h2>Loading...</h2>';
  
  // Logic to render Feed, Profile, Search, etc.
  if(view === 'feed') area.innerHTML = '<div class="glass-card">Home Feed Coming Soon</div>';
  if(view === 'profile') area.innerHTML = `<div class="glass-card">User: ${currentUser.name}</div>`;
}

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    loadView(item.dataset.view);
  });
});

document.addEventListener('DOMContentLoaded', initApp);
    
