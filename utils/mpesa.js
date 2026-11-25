// utils/mpesa.js
// Minimal Daraja (M-Pesa) STK Push client — access token, STK push, STK query.
import axios from "axios";

const isProd = (process.env.MPESA_ENV || "sandbox") === "production";
const BASE_URL = isProd
  ? "https://api.safaricom.co.ke"
  : "https://sandbox.safaricom.co.ke";

const HTTP_TIMEOUT = 15000; // never let a hung Daraja call freeze a checkout

let cachedToken = null;
let cachedTokenExpiry = 0;

// Call once at startup: tells you immediately if something is missing,
// instead of failing at the first real sale.
export const checkMpesaConfig = () => {
  const required = [
    "MPESA_CONSUMER_KEY", "MPESA_CONSUMER_SECRET",
    "MPESA_SHORTCODE", "MPESA_PASSKEY", "MPESA_CALLBACK_URL",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.warn(`⚠️  M-Pesa not fully configured. Missing: ${missing.join(", ")}`);
    return;
  }
  if (isProd && !/^https:\/\//.test(process.env.MPESA_CALLBACK_URL)) {
    console.warn("⚠️  MPESA_CALLBACK_URL must be a public HTTPS URL in production");
  }
  console.log(`✅ M-Pesa configured (${isProd ? "PRODUCTION" : "sandbox"})`);
};

export const getAccessToken = async () => {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  // trim() guards against stray spaces/newlines pasted into Render env vars
  const key = (process.env.MPESA_CONSUMER_KEY || "").trim();
  const secret = (process.env.MPESA_CONSUMER_SECRET || "").trim();

  if (!key || !secret) {
    throw new Error("MPESA_CONSUMER_KEY / MPESA_CONSUMER_SECRET not configured");
  }

  const auth = Buffer.from(`${key}:${secret}`).toString("base64");

  try {
    const { data } = await axios.get(
      `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { Authorization: `Basic ${auth}` }, timeout: HTTP_TIMEOUT }
    );

    cachedToken = data.access_token;
    cachedTokenExpiry = Date.now() + (Number(data.expires_in || 3599) - 60) * 1000;
    return cachedToken;
  } catch (err) {
    if (err.response?.status === 400 || err.response?.status === 401) {
      // Keep err.response/err.config intact for the controllers' logging,
      // but give the UI a message that points at the real problem.
      err.message =
        "M-Pesa rejected the app credentials. Check MPESA_CONSUMER_KEY / MPESA_CONSUMER_SECRET (must be Go Live keys, not sandbox).";
    }
    throw err;
  }
};

const timestamp = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
};

const buildPassword = (ts) => {
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  return Buffer.from(`${shortcode}${passkey}${ts}`).toString("base64");
};

// Daraja expects AccountReference / TransactionDesc to be plain
// alphanumeric text. Strips anything else (e.g. the "#" in "#B0127") and
// trims to the field's max length.
const clean = (value, maxLen) =>
  String(value || "")
    .replace(/[^A-Za-z0-9 ]/g, "")
    .trim()
    .slice(0, maxLen);

// Normalizes 07xx / 01xx / +2547xx / 2547xx -> 2547xxxxxxxx
export const formatMpesaPhone = (phone) => {
  let p = String(phone || "").replace(/\D/g, "");
  if (p.startsWith("0")) p = "254" + p.slice(1);
  else if (p.startsWith("7") || p.startsWith("1")) p = "254" + p;

  if (p.startsWith("254") && p.length === 12) return p;
  throw new Error("Enter a valid Safaricom M-Pesa number, e.g. 0712345678");
};

export const stkPush = async ({ phone, amount, accountRef, description }) => {
  const token = await getAccessToken();
  const ts = timestamp();
  const shortcode = process.env.MPESA_SHORTCODE; // Store number (builds the password)
  // Till number that receives the money. Only set MPESA_TILL_NUMBER if it
  // differs from the store number; otherwise it falls back to the shortcode.
  const partyB = process.env.MPESA_TILL_NUMBER || shortcode;
  const formattedPhone = formatMpesaPhone(phone);

  const payload = {
    BusinessShortCode: shortcode,
    Password: buildPassword(ts),
    Timestamp: ts,
    TransactionType: process.env.MPESA_TRANSACTION_TYPE || "CustomerBuyGoodsOnline",
    Amount: Math.max(1, Math.ceil(amount)),
    PartyA: formattedPhone,
    PartyB: partyB,
    PhoneNumber: formattedPhone,
    CallBackURL: process.env.MPESA_CALLBACK_URL,
    AccountReference: clean(accountRef, 12) || "RestoPOS",
    TransactionDesc: clean(description, 13) || "Bill payment",
  };

  const { data } = await axios.post(
    `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
    payload,
    { headers: { Authorization: `Bearer ${token}` }, timeout: HTTP_TIMEOUT }
  );

  return data; // { MerchantRequestID, CheckoutRequestID, ResponseCode, ResponseDescription, ... }
};

export const stkQuery = async (checkoutRequestId) => {
  const token = await getAccessToken();
  const ts = timestamp();
  const shortcode = process.env.MPESA_SHORTCODE;

  const payload = {
    BusinessShortCode: shortcode,
    Password: buildPassword(ts),
    Timestamp: ts,
    CheckoutRequestID: checkoutRequestId,
  };

  const { data } = await axios.post(
    `${BASE_URL}/mpesa/stkpushquery/v1/query`,
    payload,
    { headers: { Authorization: `Bearer ${token}` }, timeout: HTTP_TIMEOUT }
  );

  return data; // { ResultCode, ResultDesc, ... }
};
