document.getElementById('btn-login').addEventListener('click', async () => {
  await fetch('/api/mock/login', { method: 'POST' });
  const next = new URLSearchParams(location.search).get('next') || '/v2/web/index';
  location.href = next;
});
