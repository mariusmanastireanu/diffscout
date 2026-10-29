const $ = (id) => document.getElementById(id);
const status = (msg) => { $('status').textContent = msg; };

chrome.storage.local.get('token').then(({ token }) => { if (token) status('A token is saved.'); });

$('save').onclick = async () => {
  const token = $('token').value.trim();
  if (!token) return status('Paste a token first.');
  await chrome.storage.local.set({ token });
  $('token').value = '';
  status('Saved.');
};

$('clear').onclick = async () => {
  await chrome.storage.local.remove('token');
  status('Token removed.');
};

$('test').onclick = async () => {
  const res = await chrome.runtime.sendMessage({ type: 'api', path: '/rate_limit' });
  if (!res.ok) return status(`Request failed (${res.status || res.error}).`);
  const core = res.data.resources.core;
  status(`${res.data.resources.core.limit === 60 ? 'No token in use' : 'Token works'}: ${core.remaining}/${core.limit} requests left this hour.`);
};
