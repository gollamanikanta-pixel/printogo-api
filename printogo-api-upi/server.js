const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ files: {}, orders: {} }, null, 2));

function readDB() { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function writeDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

const UPI_ID = process.env.UPI_ID || '7207210732@ybl';
const UPI_NAME = process.env.UPI_NAME || 'PrintoGo';

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${uuidv4()}.pdf`),
  }),
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('Only PDF files are allowed'));
    cb(null, true);
  },
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// ---------- Pricing ----------
function calcPrice({ pages, copies, color, side, deliveryOption }) {
  const perPage = color === 'color' ? 8 : 2;
  const sideMultiplier = side === 'double' ? 0.6 : 1;
  const printCost = Math.ceil(pages * perPage * sideMultiplier) * copies;
  const convenienceFee = 15;
  const deliveryFee = deliveryOption === 'delivery' ? 25 : 0;
  const total = printCost + convenienceFee + deliveryFee;
  return { perPage, printCost, convenienceFee, deliveryFee, total };
}

function buildUpiLink(orderId, amount) {
  const params = new URLSearchParams({
    pa: UPI_ID,
    pn: UPI_NAME,
    am: String(amount),
    cu: 'INR',
    tn: `PrintoGo Order ${orderId}`,
  });
  return `upi://pay?${params.toString()}`;
}

// ---------- Upload PDF ----------
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const buffer = fs.readFileSync(req.file.path);
    let pages = 1;
    try {
      const parsed = await pdfParse(buffer);
      pages = parsed.numpages || 1;
    } catch (e) {}
    const fileId = uuidv4();
    const db = readDB();
    db.files[fileId] = {
      id: fileId,
      originalName: req.file.originalname,
      storedPath: req.file.filename,
      pages,
      sizeMB: +(req.file.size / (1024 * 1024)).toFixed(2),
      uploadedAt: new Date().toISOString(),
    };
    writeDB(db);
    res.json({ fileId, fileName: req.file.originalname, pages, sizeMB: db.files[fileId].sizeMB });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Quote (live price preview) ----------
app.post('/api/quote', (req, res) => {
  const { fileId, copies = 1, color = 'bw', side = 'single', deliveryOption = 'pickup' } = req.body;
  const db = readDB();
  const file = db.files[fileId];
  if (!file) return res.status(404).json({ error: 'File not found' });
  const price = calcPrice({ pages: file.pages, copies, color, side, deliveryOption });
  res.json({ pages: file.pages, copies, color, side, deliveryOption, ...price });
});

// ---------- Create order (UPI, no gateway) ----------
app.post('/api/orders', (req, res) => {
  try {
    const { fileId, copies = 1, color = 'bw', side = 'single', deliveryOption = 'pickup', printerIp, printerName } = req.body;
    const db = readDB();
    const file = db.files[fileId];
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (!printerIp) return res.status(400).json({ error: 'printerIp is required' });

    const price = calcPrice({ pages: file.pages, copies, color, side, deliveryOption });
    const orderId = 'PG' + Math.floor(1000 + Math.random() * 9000);
    const upiLink = buildUpiLink(orderId, price.total);

    db.orders[orderId] = {
      id: orderId,
      fileId,
      fileName: file.originalName,
      pages: file.pages,
      copies, color, side, deliveryOption, printerIp, printerName: printerName || '',
      ...price,
      status: 'created', // created -> pending_confirmation -> paid -> queued -> printing -> completed
      utr: null,
      createdAt: new Date().toISOString(),
      timeline: [{ status: 'created', at: new Date().toISOString() }],
    };
    writeDB(db);

    res.json({
      orderId,
      upiLink,
      upiId: UPI_ID,
      payeeName: UPI_NAME,
      amount: price.total,
      order: db.orders[orderId],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Customer: "I've completed the payment" ----------
app.post('/api/orders/:id/mark-paid', (req, res) => {
  const { utr } = req.body;
  const db = readDB();
  const order = db.orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Order not found' });

  order.status = 'pending_confirmation';
  order.utr = utr || null;
  order.timeline.push({ status: 'pending_confirmation', at: new Date().toISOString() });
  writeDB(db);
  res.json({ success: true, order });
});

// ---------- Shopkeeper: list orders awaiting confirmation for their printer ----------
app.get('/api/shop/pending', (req, res) => {
  const { printerIp } = req.query;
  if (!printerIp) return res.status(400).json({ error: 'printerIp is required' });
  const db = readDB();
  const pending = Object.values(db.orders)
    .filter((o) => o.printerIp === printerIp && o.status === 'pending_confirmation')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  res.json(pending);
});

// ---------- Shopkeeper: confirm payment actually received ----------
app.post('/api/orders/:id/confirm-payment', (req, res) => {
  const db = readDB();
  const order = db.orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'pending_confirmation') {
    return res.status(400).json({ error: `Order is in status "${order.status}", not awaiting confirmation` });
  }
  order.status = 'paid';
  order.timeline.push({ status: 'paid', at: new Date().toISOString() });
  writeDB(db);
  res.json({ success: true, order });
});

// ---------- Shopkeeper: reject / mark payment not received ----------
app.post('/api/orders/:id/reject-payment', (req, res) => {
  const db = readDB();
  const order = db.orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Order not found' });
  order.status = 'rejected';
  order.timeline.push({ status: 'rejected', at: new Date().toISOString() });
  writeDB(db);
  res.json({ success: true, order });
});

// ---------- Order status (customer polls this) ----------
app.get('/api/orders/:id', (req, res) => {
  const db = readDB();
  const order = db.orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

// ---------- Print Agent: fetch pending jobs for a printer IP ----------
app.get('/api/agent/jobs', (req, res) => {
  const { printerIp } = req.query;
  if (!printerIp) return res.status(400).json({ error: 'printerIp is required' });
  const db = readDB();
  const jobs = Object.values(db.orders).filter(
    (o) => o.printerIp === printerIp && o.status === 'paid'
  );
  jobs.forEach((o) => {
    o.status = 'queued';
    o.timeline.push({ status: 'queued', at: new Date().toISOString() });
  });
  writeDB(db);
  res.json(jobs.map((o) => ({
    orderId: o.id,
    fileId: o.fileId,
    fileName: o.fileName,
    copies: o.copies,
    color: o.color,
    side: o.side,
    fileUrl: `/api/files/${o.fileId}`,
  })));
});

// ---------- Print Agent: download the PDF to print ----------
app.get('/api/files/:fileId', (req, res) => {
  const db = readDB();
  const file = db.files[req.params.fileId];
  if (!file) return res.status(404).send('File not found');
  res.setHeader('Content-Type', 'application/pdf');
  res.sendFile(path.join(UPLOAD_DIR, file.storedPath));
});

// ---------- Print Agent: update job status ----------
app.post('/api/orders/:id/status', (req, res) => {
  const { status } = req.body; // 'printing' | 'completed' | 'failed'
  const db = readDB();
  const order = db.orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Order not found' });
  order.status = status;
  order.timeline.push({ status, at: new Date().toISOString() });
  writeDB(db);
  res.json({ success: true, order });
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PrintoGo API (UPI mode) listening on ${PORT}`));
