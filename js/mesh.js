/*
 * ProxiTalk transport status for the web preview.
 * This deliberately does not invent peers, simulate routing, or imply delivery.
 * A production BLE mesh implementation requires the native Android transport.
 */
const MeshEngine = (() => {
  const stats = { delivered: 0, totalHops: 0, synced: 0, relayed: 0 };
  const queue = [];
  const syncLog = [];
  let onStats = null;
  let canvas = null;
  let ctx = null;

  function emitStats() {
    onStats?.({
      stats: getStats(),
      queue,
      syncLog,
      nodes: [],
      internetOnline: navigator.onLine,
      relayEnabled: false,
    });
  }

  function draw() {
    if (!ctx || !canvas) return;
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(0,194,168,0.05)';
    for (let x = 0; x < width; x += 34) {
      for (let y = 0; y < height; y += 34) {
        ctx.beginPath(); ctx.arc(x, y, 1, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.fillStyle = '#00C2A8';
    ctx.beginPath(); ctx.arc(width / 2, height / 2 - 12, 10, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#E9EDEF';
    ctx.textAlign = 'center';
    ctx.font = '12px sans-serif';
    ctx.fillText('This device only', width / 2, height / 2 + 18);
    ctx.fillStyle = '#9AA7A5';
    ctx.font = '11px sans-serif';
    ctx.fillText('No live peers or radio transport connected', width / 2, height / 2 + 38);
  }

  function init(canvasEl, opts = {}) {
    canvas = canvasEl || null;
    ctx = canvas?.getContext?.('2d') || null;
    onStats = opts.onStats || null;
    // Clear any packet queue persisted by the old simulated prototype.
    try { Store.remove('mesh_queue'); } catch (_) {}
    draw();
    emitStats();
  }

  function send(packet) {
    return { ...packet, status: 'local', hops: 0, path: [], ttl: 0 };
  }
  function setInternet() { emitStats(); }
  function setRelay() { emitStats(); }
  function getNodes() { return []; }
  function getQueue() { return queue; }
  function getStats() { return { ...stats, avgHops: '0' }; }
  function getSyncLog() { return syncLog; }
  function nearbyCount() { return 0; }
  function youNode() { return { id: 'local', name: 'This device', x: 0, y: 0 }; }

  return { init, send, setInternet, setRelay, getNodes, getQueue, getStats, getSyncLog, nearbyCount, youNode };
})();
