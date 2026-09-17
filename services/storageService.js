import { v2 as cloudinary } from "cloudinary";
import crypto from "crypto";
import path from "path";

/**
 * Checks whether all required Cloudinary environment variables are present.
 */
export function isCloudinaryConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

/**
 * Configures Cloudinary using server-side environment variables.
 * Never logs or exposes credentials.
 */
function ensureCloudinaryConfig() {
  if (!isCloudinaryConfigured()) {
    throw new Error(
      "Cloudinary is not configured. Please set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in the backend environment."
    );
  }

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

/**
 * Validates the image buffer against known signatures (magic bytes)
 * to prevent executable or malformed files from being processed.
 */
export function validateImageBuffer(buffer, mimetype = "") {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Invalid or empty image file buffer.");
  }

  // Max size: 10MB
  const MAX_SIZE = 10 * 1024 * 1024;
  if (buffer.length > MAX_SIZE) {
    throw new Error("Image file exceeds the maximum allowed size of 10MB.");
  }

  const hex = buffer.subarray(0, 16).toString("hex").toUpperCase();

  // JPEG: FF D8 FF
  const isJpeg = hex.startsWith("FFD8FF");

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const isPng = hex.startsWith("89504E470D0A1A0A");

  // GIF: 47 49 46 38 ('GIF8')
  const isGif = hex.startsWith("47494638");

  // WebP: RIFF ... WEBP (starts with 52494646, offset 8-11 is 57454250)
  const isWebp =
    hex.startsWith("52494646") &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP";

  // AVIF: offset 4-11 contains ftyp with avif, avis, or mif1
  const isAvif =
    buffer.length >= 12 &&
    buffer.subarray(4, 8).toString("ascii") === "ftyp" &&
    ["avif", "avis", "mif1"].some((sig) =>
      buffer.subarray(8, 12).toString("ascii").toLowerCase().includes(sig)
    );

  // SVG: starts with XML declaration or <svg
  const textPrefix = buffer.subarray(0, 256).toString("utf8").trim().toLowerCase();
  const isSvg = textPrefix.startsWith("<svg") || (textPrefix.startsWith("<?xml") && textPrefix.includes("<svg"));

  const isValid = isJpeg || isPng || isGif || isWebp || isAvif || isSvg;

  if (!isValid) {
    throw new Error(
      "Unsupported image format. Allowed formats are JPEG, PNG, WebP, AVIF, and GIF."
    );
  }

  return true;
}

/**
 * Generates a clean, stable public ID for an uploaded menu image.
 * Keeps all menu images grouped neatly under rustic-charm/menu without folder sprawl.
 */
function generateSensiblePublicId(originalFilename = "") {
  let baseName = "item";
  if (originalFilename) {
    const ext = path.extname(originalFilename);
    const rawName = path.basename(originalFilename, ext);
    const sanitized = rawName
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    if (sanitized) baseName = sanitized;
  }

  const timestamp = Date.now();
  const randomSuffix = crypto.randomBytes(4).toString("hex");
  return `${baseName}-${timestamp}-${randomSuffix}`;
}

/**
 * Uploads an image buffer directly to Cloudinary into the rustic-charm/menu folder.
 * Returns the secure, optimized delivery HTTPS URL.
 *
 * @param {Buffer} buffer - In-memory image file buffer
 * @param {Object} [options]
 * @param {string} [options.originalFilename] - Original filename for building public ID
 * @returns {Promise<{ url: string, publicId: string, format: string, width: number, height: number, bytes: number }>}
 */
export async function uploadImageToCloudinary(buffer, options = {}) {
  ensureCloudinaryConfig();
  validateImageBuffer(buffer);

  const publicId = generateSensiblePublicId(options.originalFilename);

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: "rustic-charm/menu",
        public_id: publicId,
        resource_type: "image",
        overwrite: true,
        timeout: 30000, // 30s timeout
      },
      (error, result) => {
        if (error) {
          console.error("[cloudinary] Upload failed:", error.message || error);
          return reject(new Error(error.message || "Cloudinary upload failed"));
        }

        if (!result || !result.secure_url) {
          return reject(new Error("Cloudinary did not return a valid secure URL"));
        }

        // Generate optimized delivery URL with f_auto,q_auto
        // CDN serves modern formats (WebP/AVIF) and perceptual compression automatically,
        // without cropping or modifying the original aspect ratio or dimensions.
        let deliveryUrl = "";
        try {
          deliveryUrl = cloudinary.url(result.public_id, {
            secure: true,
            fetch_format: "auto",
            quality: "auto",
            version: result.version,
          });
        } catch (urlErr) {
          console.warn("[cloudinary] Delivery URL generation warning:", urlErr.message);
        }

        // Fallback to secure_url if transformation URL generation fails
        const finalUrl = deliveryUrl || result.secure_url;

        console.log(`[cloudinary] Successfully uploaded: ${result.public_id}`);

        resolve({
          url: finalUrl,
          publicId: result.public_id,
          format: result.format,
          width: result.width,
          height: result.height,
          bytes: result.bytes,
        });
      }
    );

    uploadStream.on("error", (streamErr) => {
      console.error("[cloudinary] Upload stream error:", streamErr.message);
      reject(new Error(streamErr.message || "Upload stream error"));
    });

    uploadStream.end(buffer);
  });
}
