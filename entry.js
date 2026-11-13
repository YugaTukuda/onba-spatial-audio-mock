// The public mock expires independently of the scheduled server-side shutdown.
const expiresAt = Date.parse('2026-12-30T00:00:00+09:00');
if (Date.now() >= expiresAt) {
  document.body.innerHTML = '<main style="max-width:600px;margin:15vh auto;padding:28px;font:16px system-ui;line-height:2"><p>ONBA · SHARED MOCK</p><h1>このモックの公開は終了しました。</h1><p>公開終了：2026年12月30日（日本時間）</p></main>';
} else {
  await import('./app.js');
  const check = () => { if (Date.now() >= expiresAt) location.reload(); };
  setInterval(check, 60000);
  document.addEventListener('visibilitychange', check);
}
