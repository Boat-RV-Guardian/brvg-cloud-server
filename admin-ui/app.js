const API_BASE = '/admin/api';
let authToken = '';

// DOM Elements
const loginContainer = document.getElementById('login-container');
const dashboardContainer = document.getElementById('dashboard-container');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');
const toastEl = document.getElementById('toast');
const statusBadge = document.getElementById('status-badge');
const vehiclesTbody = document.querySelector('#vehicles-table tbody');

const settingsForm = document.getElementById('settings-form');
const vehicleForm = document.getElementById('vehicle-form');
const tokenForm = document.getElementById('token-form');

// State
let appState = null;

// Initialization
function init() {
  const savedToken = localStorage.getItem('brvg_admin_token');
  if (savedToken) {
    authToken = savedToken;
    loadDashboard();
  } else {
    showLogin();
  }
}

// API Helper
async function apiCall(endpoint, method = 'GET', body = null) {
  const headers = { 'Authorization': `Basic ${authToken}` };
  if (body) headers['Content-Type'] = 'application/json';
  
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  
  if (res.status === 401) throw new Error('Unauthorized');
  
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function showToast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.className = `toast ${isError ? 'error' : ''}`;
  setTimeout(() => toastEl.classList.add('hidden'), 3000);
}

// Auth
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('login-password').value;
  // basic auth format is base64(admin:password)
  const token = btoa(`admin:${password}`);
  authToken = token;
  
  try {
    loginError.textContent = '';
    await loadDashboard();
    localStorage.setItem('brvg_admin_token', token);
  } catch (err) {
    loginError.textContent = 'Invalid password or server error.';
    authToken = '';
  }
});

logoutBtn.addEventListener('click', () => {
  localStorage.removeItem('brvg_admin_token');
  authToken = '';
  showLogin();
});

function showLogin() {
  loginContainer.classList.remove('hidden');
  dashboardContainer.classList.add('hidden');
}

// Dashboard Logic
async function loadDashboard() {
  try {
    const data = await apiCall('/status');
    appState = data;
    
    loginContainer.classList.add('hidden');
    dashboardContainer.classList.remove('hidden');
    
    renderStatus();
    renderSettings();
    renderVehicles();
  } catch (err) {
    if (err.message === 'Unauthorized') showLogin();
    else showToast(err.message, true);
    throw err;
  }
}

function renderStatus() {
  const authOk = appState.apiKeySet || appState.allowUnauthenticated;
  if (authOk) {
    if (appState.apiKeySet) {
      statusBadge.textContent = 'API Key Set';
      statusBadge.className = 'badge ok';
    } else {
      statusBadge.textContent = 'Auth Disabled';
      statusBadge.className = 'badge warn';
    }
  } else {
    statusBadge.textContent = 'Blocked (Set API Key)';
    statusBadge.className = 'badge err';
  }
}

function renderSettings() {
  document.getElementById('apiKey').value = '';
  document.getElementById('apiKey').placeholder = appState.apiKeySet ? '(Hidden for security, enter to replace)' : '';
  document.getElementById('allowUnauth').checked = appState.allowUnauthenticated;
  document.getElementById('retentionDays').value = appState.retentionDays || 0;
}

function renderVehicles() {
  if (appState.vehicles.length === 0) {
    vehiclesTbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted)">No vehicles found</td></tr>';
    return;
  }
  
  vehiclesTbody.innerHTML = appState.vehicles.map(v => `
    <tr>
      <td><code>${escapeHtml(v.vid)}</code></td>
      <td>${escapeHtml(v.name || '—')}</td>
      <td><span class="badge ${v.tier === 'premium' ? 'ok' : 'warn'}">${escapeHtml(v.tier || '—')}</span></td>
      <td>${v.users}</td>
    </tr>
  `).join('');
}

// Form Handlers
settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const apiKey = document.getElementById('apiKey').value;
  const allowUnauth = document.getElementById('allowUnauth').checked;
  const retention = document.getElementById('retentionDays').value;
  
  const payload = {
    allowUnauthenticated: allowUnauth,
    retentionDays: Number(retention)
  };
  if (apiKey) payload.apiKey = apiKey;
  
  try {
    await apiCall('/settings', 'POST', payload);
    showToast('Settings saved successfully');
    loadDashboard();
  } catch (err) {
    showToast(err.message, true);
  }
});

vehicleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    vid: document.getElementById('v-id').value,
    name: document.getElementById('v-name').value,
    tier: document.getElementById('v-tier').value,
    allowedUsers: document.getElementById('v-users').value.split(',').map(s => s.trim()).filter(Boolean)
  };

  // Optional fields — only include them when the operator entered a value, so an omitted field keeps
  // its existing value server-side instead of being cleared. Alert events default to the full set.
  const ALERT_EVENTS = ['flood', 'low_battery', 'shore_power', 'offline'];
  const secret = document.getElementById('v-secret').value.trim();
  if (secret) payload.webhookSecret = secret;
  const wa = document.getElementById('v-whatsapp').value.split(',').map(s => s.trim()).filter(Boolean);
  if (wa.length) payload.sh_whatsapp_prefs = JSON.stringify({ addresses: wa, events: ALERT_EVENTS });
  const tg = document.getElementById('v-telegram').value.split(',').map(s => s.trim()).filter(Boolean);
  if (tg.length) payload.sh_telegram_prefs = JSON.stringify({ addresses: tg, events: ALERT_EVENTS });

  try {
    await apiCall('/vehicle', 'POST', payload);
    showToast('Vehicle saved successfully');
    vehicleForm.reset();
    loadDashboard();
  } catch (err) {
    showToast(err.message, true);
  }
});

tokenForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await apiCall('/user-token', 'POST', {
      uid: document.getElementById('u-id').value,
      token: document.getElementById('u-token').value
    });
    showToast('Token saved successfully');
    tokenForm.reset();
  } catch (err) {
    showToast(err.message, true);
  }
});

function escapeHtml(unsafe) {
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

init();
