document.getElementById('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const err = document.getElementById('err');
  err.classList.add('hidden');
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'pq-dashboard' },
    body: JSON.stringify({ email: form.email.value, password: form.password.value }),
  });
  if (res.ok) { location.href = '/app/'; return; }
  const body = await res.json().catch(() => ({}));
  err.textContent = body.error || 'Sign-in failed';
  err.classList.remove('hidden');
});
