// config/cloudinary.js
import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import multer from "multer";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Fail loudly at boot instead of silently at the first upload attempt.
const missing = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]
  .filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(`[cloudinary] ❌ Missing env vars: ${missing.join(", ")} — uploads will fail`);
} else {
  console.log(`[cloudinary] ✅ Configured — cloud_name: ${process.env.CLOUDINARY_CLOUD_NAME}`);
}

// ── Menu item image storage ─────────────────────────────────────
const menuImageStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:          "restopos/menu",
    allowed_formats:  ["jpg", "jpeg", "png", "webp"],
    transformation:   [{ width: 800, height: 800, crop: "limit" }],
  },
});

export const uploadMenuImage = multer({
  storage: menuImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// ── Kitchen notification sound storage ──────────────────────────
// Cloudinary files audio under the "video" resource type — there's no
// separate "audio" bucket. Keep that in mind for destroy() calls too.
const notificationSoundStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:          "restopos/notification-sounds",
    resource_type:   "video",
    allowed_formats:  ["mp3", "wav", "ogg", "m4a"],
  },
});

export const uploadNotificationSound = multer({
  storage: notificationSoundStorage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB — plenty for a short alert clip
});

// ── Product image storage (Supermarket) ─────────────────────────
const productImageStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:          "shoppos/products",
    allowed_formats:  ["jpg", "jpeg", "png", "webp"],
    transformation:   [
      { width: 800, height: 800, crop: "fill", gravity: "auto" },
      { quality: "auto", fetch_format: "auto" },
    ],
  },
});

export const uploadProductImage = multer({
  storage: productImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

export { cloudinary };
