const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const status = (msg, error = false) => { $('status').textContent = msg; $('status').className = error ? 'error' : ''; };

let verificationUri = '';

async function render() {
  const [{ token, auth }, { signIn }] = await Promise.all([chrome.storage.local.get(['token', 'auth']), chrome.storage.session.get('signIn')]);
  const waiting = signIn?.status === 'waiting';
  $('pending').hidden = !waiting;
  $('signedIn').hidden = waiting || !token;
  $('signedOut').hidden = waiting || !!token;
  if (waiting) {
    $('code').textContent = signIn.userCode;
    verificationUri = signIn.verificationUri;
  }
  if (token) {
    $('login').textContent = auth?.login ? `@${auth.login}` : 'a saved token';
    $('method').textContent = auth?.method === 'github' ? '(via GitHub sign-in)' : '(via personal access token)';
    $('revoke').hidden = auth?.method !== 'github';
  }
  if (signIn?.status === 'error') status(signIn.error, true);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.token?.newValue && !changes.token.oldValue) status('Signed in.');
  render();
});
render();

$('signIn').onclick = async () => {
  $('signIn').disabled = true;
  status('Contacting GitHub…');
  await chrome.storage.session.remove('signIn');
  const res = await send({ type: 'signIn' });
  $('signIn').disabled = false;
  status(res.ok ? '' : `Couldn't start sign-in: ${res.error}`, !res.ok);
};

$('copyOpen').onclick = async () => {
  await navigator.clipboard.writeText($('code').textContent).catch(() => {});
  send({ type: 'openTab', url: verificationUri });
  status('Code copied. Paste it on GitHub.');
};
$('cancel').onclick = async () => { await send({ type: 'signInCancel' }); status(''); };

$('signOut').onclick = async () => {
  await send({ type: 'signOut' });
  status('Signed out.');
};
$('appSettings').onclick = (e) => { e.preventDefault(); send({ type: 'openAppSettings' }); };

$('test').onclick = async () => {
  const res = await send({ type: 'api', path: '/rate_limit' });
  if (!res.ok) return status(res.authFailed ? 'GitHub rejected the saved credentials. Sign in again.' : `Request failed (${res.status || res.error}).`, true);
  const core = res.data.resources.core;
  status(`Working: ${core.remaining}/${core.limit} GitHub requests left this hour.`);
};

$('save').onclick = async () => {
  const token = $('token').value.trim();
  if (!token) return status('Paste a token first.', true);
  $('save').disabled = true;
  status('Checking the token…');
  const res = await send({ type: 'saveToken', token });
  $('save').disabled = false;
  if (!res.ok) return status(res.error, true);
  $('token').value = '';
  $('advanced').open = false;
  status(`Token saved for @${res.login}.`);
};
