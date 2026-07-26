const API_BASE = 'https://printogo-api2-production.up.railway.app';

const state = {
  fileId: null,
  fileName: null,
  fileMeta: null,
  copies: 1,
  color: 'bw',
  side: 'single',
  deliveryOption: 'pickup',
  printerIp: '',
  printerName: '',
  quote: null,
  orderId: null,
  razorpayOrderId: null,
  pollTimer: null,
};

const App = {
  go(screen) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    document.getElementById('screen-' + screen).classList.add('active');
    window.scrollTo(0, 0);
  },

  removeFile() {
    state.fileId = null;
    document.getElementById('fileCard').hidden = true;
    document.getElementById('dropzone').style.display = 'flex';
    document.getElementById('uploadContinue').disabled = true;
    document.getElementById('fileInput').value = '';
  },

  async uploadFile(file) {
    const statusEl = document.getElementById('uploadStatus');
    if (file.type !== 'application/pdf') {
      statusEl.textContent = 'Only PDF files are allowed.';
      statusEl.className = 'hint error';
      return;
    }
    statusEl.textContent = 'Uploading…';
    statusEl.className = 'hint';
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');

      state.fileId = data.fileId;
      state.fileName = data.fileName;
      state.fileMeta = `${data.pages} Pages · ${data.sizeMB} MB`;

      document.getElementById('fileName').textContent = state.fileName;
      document.getElementById('fileMeta').textContent = state.fileMeta;
      document.getElementById('fileCard').hidden = false;
      document.getElementById('dropzone').style.display = 'none';
      document.getElementById('uploadContinue').disabled = false;
      statusEl.textContent = '';
    } catch (err) {
      statusEl.textContent = err.message || 'Upload failed. Check your connection and try again.';
      statusEl.className = 'hint error';
    }
  },

  changeCopies(delta) {
    state.copies = Math.max(1, Math.min(99, state.copies + delta));
    document.getElementById('copiesVal').textContent = state.copies;
  },

  setOpt(key, val, btn) {
    state[key] = val;
    btn.parentElement.querySelectorAll('.toggle-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  },

  async goSummary() {
    const ipInput = document.getElementById('printerIp').value.trim();
    const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipPattern.test(ipInput)) {
      alert('Please enter a valid printer IP address (ask the shopkeeper), e.g. 192.168.1.108');
      return;
    }
    state.printerIp = ipInput;
    state.printerName = document.getElementById('printerName').value.trim();

    document.getElementById('sumFileName').textContent = state.fileName;
    document.getElementById('sumFileMeta').textContent = state.fileMeta;

    const listEl = document.getElementById('summaryList');
    const errEl = document.getElementById('summaryError');
    listEl.innerHTML = '<div class="summary-row"><span>Calculating…</span><span></span></div>';
    errEl.textContent = '';
    App.go('summary');

    try {
      const res = await fetch(`${API_BASE}/api/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId: state.fileId,
          copies: state.copies,
          color: state.color,
          side: state.side,
          deliveryOption: state.deliveryOption,
        }),
      });
      const q = await res.json();
      if (!res.ok) throw new Error(q.error || 'Could not calculate price');
      state.quote = q;

      listEl.innerHTML = `
        <div class="summary-row"><span>Copies</span><span>× ${q.copies}</span></div>
        <div class="summary-row"><span>Print Mode</span><span>${q.color === 'color' ? 'Color' : 'Black & White'}</span></div>
        <div class="summary-row"><span>Print Side</span><span>${q.side === 'double' ? 'Double Side' : 'Single Side'}</span></div>
        <div class="summary-row"><span>Delivery</span><span>${q.deliveryOption === 'delivery' ? 'Delivery' : 'Self Pickup'}</span></div>
        <div class="summary-row"><span>Print Cost</span><span>₹${q.printCost}</span></div>
        <div class="summary-row"><span>Convenience Fee</span><span>₹${q.convenienceFee}</span></div>
        ${q.deliveryFee ? `<div class="summary-row"><span>Delivery Fee</span><span>₹${q.deliveryFee}</span></div>` : ''}
      `;
      document.getElementById('totalAmt').textContent = `₹${q.total}`;
    } catch (err) {
      errEl.textContent = err.message;
    }
  },

  async pay() {
    const payBtn = document.getElementById('payBtn');
    const errEl = document.getElementById('summaryError');
    errEl.textContent = '';
    payBtn.disabled = true;
    payBtn.textContent = 'Preparing payment…';

    try {
      const res = await fetch(`${API_BASE}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId: state.fileId,
          copies: state.copies,
          color: state.color,
          side: state.side,
          deliveryOption: state.deliveryOption,
          printerIp: state.printerIp,
        }),
      });
      const order = await res.json();
      if (!res.ok) throw new Error(order.error || 'Could not create order');

      state.orderId = order.orderId;
      state.razorpayOrderId = order.razorpayOrderId;

      const rzp = new Razorpay({
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        name: 'PrintoGo',
        description: `${state.fileName} · ${state.copies} cop${state.copies > 1 ? 'ies' : 'y'}`,
        order_id: order.razorpayOrderId,
        theme: { color: '#2B2E83' },
        handler: async function (response) {
          await App.verifyPayment(response);
        },
        modal: {
          ondismiss: function () {
            payBtn.disabled = false;
            payBtn.textContent = 'Pay Securely';
          },
        },
      });
      rzp.on('payment.failed', function (resp) {
        errEl.textContent = 'Payment failed: ' + (resp.error && resp.error.description ? resp.error.description : 'please try again.');
        payBtn.disabled = false;
        payBtn.textContent = 'Pay Securely';
      });
      rzp.open();
      payBtn.textContent = 'Pay Securely';
    } catch (err) {
      errEl.textContent = err.message;
      payBtn.disabled = false;
      payBtn.textContent = 'Pay Securely';
    }
  },

  async verifyPayment(response) {
    try {
      const res = await fetch(`${API_BASE}/api/orders/${state.orderId}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          razorpay_payment_id: response.razorpay_payment_id,
          razorpay_order_id: response.razorpay_order_id,
          razorpay_signature: response.razorpay_signature,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Payment verification failed');
      App.showStatus(data.order);
      App.startPolling();
    } catch (err) {
      document.getElementById('summaryError').textContent = err.message;
    }
  },

  showStatus(order) {
    document.getElementById('statusOrderId').textContent = order.id;
    document.getElementById('statusAmount').textContent = `₹${order.total}`;
    const qr = document.getElementById('qrImg');
    qr.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(order.id)}`;
    qr.hidden = false;

    const steps = ['created', 'paid', 'queued', 'printing', 'completed'];
    const labels = {
      created: 'Order Placed',
      paid: 'Payment Confirmed',
      queued: 'Sent to Printer',
      printing: 'Printing',
      completed: order.deliveryOption === 'delivery' ? 'Out for Delivery' : 'Ready for Pickup',
    };
    const currentIdx = steps.indexOf(order.status);
    const tl = document.getElementById('timeline');
    tl.innerHTML = steps.map((s, i) => {
      const cls = i < currentIdx ? 'done' : i === currentIdx ? 'current' : '';
      return `<li class="${cls}">${labels[s]}</li>`;
    }).join('');

    const liveBox = document.getElementById('printerLive');
    const liveText = document.getElementById('printerLiveText');
    const icon = document.getElementById('statusIcon');
    const title = document.getElementById('statusTitle');
    const sub = document.getElementById('statusSub');

    if (order.status === 'paid') {
      icon.textContent = '✅'; title.textContent = 'Payment Successful';
      sub.textContent = 'Waiting for the shop printer to pick up your job…';
      liveBox.hidden = false; liveText.textContent = `Waiting for printer at ${order.printerIp} to connect…`;
    } else if (order.status === 'queued') {
      icon.textContent = '📡'; title.textContent = 'Connecting to Printer';
      sub.textContent = `Sent to printer at ${order.printerIp}`;
      liveBox.hidden = false; liveText.textContent = 'Printer received the job. Please wait…';
    } else if (order.status === 'printing') {
      icon.textContent = '🖨️'; title.textContent = 'Printing in Progress';
      sub.textContent = 'Your document is being printed. Please wait a moment.';
      liveBox.hidden = false; liveText.textContent = 'Do not close the app.';
    } else if (order.status === 'completed') {
      icon.textContent = '🎉';
      title.textContent = order.deliveryOption === 'delivery' ? 'Out for Delivery' : 'Ready for Pickup!';
      sub.textContent = order.deliveryOption === 'delivery'
        ? 'Your print job is done and on its way.'
        : `Show this QR code at ${order.printerName || 'the shop'} to collect your prints.`;
      liveBox.hidden = true;
      App.stopPolling();
    } else {
      icon.textContent = '⏳'; title.textContent = 'Processing…'; sub.textContent = '';
    }

    App.go('status');
  },

  startPolling() {
    App.stopPolling();
    state.pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/orders/${state.orderId}`);
        const order = await res.json();
        if (res.ok) App.showStatus(order);
      } catch (e) { /* keep polling silently */ }
    }, 4000);
  },

  stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  },
};

// ---------- Wire up upload interactions ----------
document.addEventListener('DOMContentLoaded', () => {
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) App.uploadFile(e.target.files[0]);
  });

  ['dragenter', 'dragover'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.style.borderColor = '#2B2E83'; })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.style.borderColor = '#C7C9E8'; })
  );
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) App.uploadFile(file);
  });
});
