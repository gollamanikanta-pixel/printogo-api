/**
 * PrintoGo Print Agent
 * ---------------------
 * Run this on any PC/laptop that is on the SAME Wi-Fi network as the printer.
 * It polls the PrintoGo backend for paid orders assigned to your printer's IP,
 * downloads the PDF, and sends a real print job to the printer over IPP (port 631).
 *
 * Setup:
 *   1. npm install
 *   2. Edit config.json: set PRINTER_IP to your printer's local IP (find it in
 *      the printer's network settings menu), and give customers that same IP
 *      to enter in the app.
 *   3. npm start
 *   Leave this running while the shop is open.
 */
const fetch = require('node-fetch');
const ipp = require('ipp');
const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const { API_BASE, PRINTER_IP, PRINTER_NAME, POLL_SECONDS } = config;

const printerUri = `http://${PRINTER_IP}:631/ipp/print`;
const printer = ipp.Printer(printerUri);

function log(...args) {
  console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

async function updateStatus(orderId, status) {
  try {
    await fetch(`${API_BASE}/api/orders/${orderId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
  } catch (e) {
    log(`⚠ Could not update status for ${orderId}:`, e.message);
  }
}

function sendToPrinter(pdfBuffer, job) {
  return new Promise((resolve, reject) => {
    const msg = {
      'operation-attributes-tag': {
        'requesting-user-name': 'PrintoGo',
        'job-name': job.fileName || `PrintoGo-${job.orderId}`,
        'document-format': 'application/pdf',
      },
      'job-attributes-tag': {
        copies: job.copies || 1,
        sides: job.side === 'double' ? 'two-sided-long-edge' : 'one-sided',
        'print-color-mode': job.color === 'color' ? 'color' : 'monochrome',
      },
      data: pdfBuffer,
    };
    printer.execute('Print-Job', msg, (err, res) => {
      if (err) return reject(err);
      if (res && res.statusCode && !res.statusCode.startsWith('successful')) {
        return reject(new Error(`Printer responded: ${res.statusCode}`));
      }
      resolve(res);
    });
  });
}

async function processJob(job) {
  log(`🖨  New job: ${job.fileName} (order ${job.orderId}, ${job.copies}x)`);
  try {
    await updateStatus(job.orderId, 'printing');
    const fileRes = await fetch(`${API_BASE}${job.fileUrl}`);
    if (!fileRes.ok) throw new Error(`Could not download file: ${fileRes.status}`);
    const pdfBuffer = await fileRes.buffer();

    await sendToPrinter(pdfBuffer, job);
    log(`✅ Sent to printer: order ${job.orderId}`);

    await updateStatus(job.orderId, 'completed');
    log(`🎉 Order ${job.orderId} marked completed — ready for pickup.`);
  } catch (err) {
    log(`❌ Failed to print order ${job.orderId}:`, err.message);
    await updateStatus(job.orderId, 'failed');
  }
}

async function poll() {
  try {
    const res = await fetch(`${API_BASE}/api/agent/jobs?printerIp=${encodeURIComponent(PRINTER_IP)}`);
    if (!res.ok) {
      log('⚠ Could not reach PrintoGo backend:', res.status);
      return;
    }
    const jobs = await res.json();
    for (const job of jobs) {
      await processJob(job);
    }
  } catch (err) {
    log('⚠ Poll error:', err.message);
  }
}

log(`PrintoGo Print Agent starting`);
log(`Printer: ${PRINTER_NAME || '(unnamed)'} @ ${printerUri}`);
log(`Watching for paid orders on printer IP ${PRINTER_IP} every ${POLL_SECONDS}s…`);
setInterval(poll, POLL_SECONDS * 1000);
poll();
