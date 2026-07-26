const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Razorpay = require('razorpay');
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

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

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
  const sideMultiplier = side === 'double' ? 0.6 : 1; // double-side saves paper cost
  const printCost = Math.ceil(pages * perPage * sideMultiplier) * copies;
  const convenienceFee = 15;
  const deliveryFee = deliveryOption === 'delivery' ? 25 : 0;
  const total = printCost + convenienceFee + deliveryFee;
  return { perPage, printCost, convenienceFee, deliveryFee, total };
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
    } catch (e) {
      // fall back to 1 page if parsing fails
    }
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

// ---------- Create order + Razorpay order ----------
app.post('/api/orders', async (req, res) => {
  try {
    const { fileId, copies = 1, color = 'bw', side = 'single', deliveryOption = 'pickup', printerIp } = req.body;
    const db = readDB();
    const file = db.files[fileId];
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (!printerIp) return res.status(400).json({ error: 'printerIp is required' });

    const price = calcPrice({ pages: file.pages, copies, color, side, deliveryOption });
    const orderId = 'PG' + Math.floor(1000 + Math.random() * 9000);

    const rpOrder = await razorpay.orders.create({
      amount: price.total * 100, // paise
      currency: 'INR',
      receipt: orderId,
      notes: { fileId, printerIp },
    });

    db.orders[orderId] = {
      id: orderId,
      fileId,
      fileName: file.originalName,
      pages: file.pages,
      copies, color, side, deliveryOption, printerIp,
      ...price,
      status: 'created', // created -> paid -> queued -> printing -> completed
      razorpayOrderId: rpOrder.id,
      createdAt: new Date().toISOString(),
      timeline: [{ status: 'created', at: new Date().toISOString() }],
    };
    writeDB(db);

    res.json({
      orderId,
      razorpayOrderId: rpOrder.id,
      amount: rpOrder.amount,
      currency: rpOrder.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      order: db.orders[orderId],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Verify payment ----------
app.post('/api/orders/:id/verify', (req, res) => {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;
  const db = readDB();
  const order = db.orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expected !== razorpay_signature) {
    return res.status(400).json({ success: false, error: 'Signature verification failed' });
  }

  order.status = 'paid';
  order.paymentId = razorpay_payment_id;
  order.timeline.push({ status: 'paid', at: new Date().toISOString() });
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
  // mark as queued so they aren't picked up twice
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
app.listen(PORT, () => console.log(`PrintoGo API listening on ${PORT}`));
