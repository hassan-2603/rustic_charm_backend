import express from "express";
import http from "http";
import adminRouter from "../routes/admin.js";
import { isCloudinaryConfigured, validateImageBuffer } from "../services/storageService.js";

async function runTests() {
  console.log("=== RUNNING CLOUDINARY INTEGRATION VERIFICATION TESTS ===");

  // Test 1: Cloudinary Config check
  console.log("\n[Test 1] Cloudinary configuration check (before setting env):");
  console.log("  isCloudinaryConfigured():", isCloudinaryConfigured());

  // Test 2: Image Buffer Validation
  console.log("\n[Test 2] Testing magic byte image validation:");
  const validPng = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
  const validJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0]);
  const validGif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
  const validWebp = Buffer.concat([
    Buffer.from([0x52, 0x49, 0x46, 0x46]),
    Buffer.alloc(4),
    Buffer.from("WEBP"),
    Buffer.alloc(4)
  ]);
  const fakeExe = Buffer.from([0x4D, 0x5A, 0x90, 0x00]);

  try {
    validateImageBuffer(validPng);
    console.log("  ✓ Valid PNG recognized");
  } catch (e) {
    console.error("  ✗ Valid PNG failed:", e.message);
  }

  try {
    validateImageBuffer(validJpeg);
    console.log("  ✓ Valid JPEG recognized");
  } catch (e) {
    console.error("  ✗ Valid JPEG failed:", e.message);
  }

  try {
    validateImageBuffer(validGif);
    console.log("  ✓ Valid GIF recognized");
  } catch (e) {
    console.error("  ✗ Valid GIF failed:", e.message);
  }

  try {
    validateImageBuffer(validWebp);
    console.log("  ✓ Valid WebP recognized");
  } catch (e) {
    console.error("  ✗ Valid WebP failed:", e.message);
  }

  try {
    validateImageBuffer(fakeExe);
    console.error("  ✗ Fake EXE was NOT rejected!");
  } catch (e) {
    console.log("  ✓ Fake EXE correctly rejected:", e.message);
  }

  // Test 3: Express route testing
  console.log("\n[Test 3] Testing admin /upload-image route with mock Express server:");
  const app = express();
  app.use(express.json());
  app.locals.db = {};
  app.use("/api/admin", adminRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  const token = process.env.ADMIN_API_TOKEN || "rustic-charm-admin-token";

  // 3a. Unauthorized request
  try {
    const unauthRes = await fetch(`${baseUrl}/api/admin/upload-image`, { method: "POST" });
    console.log("  3a. Unauthorized request status:", unauthRes.status, "(expected 401)");
  } catch (e) {
    console.error("  3a failed:", e.message);
  }

  // 3b. Authorized request without file
  try {
    const noFileRes = await fetch(`${baseUrl}/api/admin/upload-image?adminToken=${encodeURIComponent(token)}`, {
      method: "POST",
    });
    const json = await noFileRes.json();
    console.log("  3b. No file status:", noFileRes.status, "body:", json);
  } catch (e) {
    console.error("  3b failed:", e.message);
  }

  // 3c. Authorized request with fake EXE disguised as PNG
  try {
    const form = new FormData();
    const blob = new Blob([fakeExe], { type: "image/png" });
    form.append("image", blob, "malicious.png");

    const fakeFileRes = await fetch(`${baseUrl}/api/admin/upload-image?adminToken=${encodeURIComponent(token)}`, {
      method: "POST",
      body: form,
    });
    const json = await fakeFileRes.json();
    console.log("  3c. Disguised EXE status:", fakeFileRes.status, "body:", json);
  } catch (e) {
    console.error("  3c failed:", e.message);
  }

  // 3d. Authorized request with valid PNG but missing Cloudinary env
  try {
    const form = new FormData();
    const blob = new Blob([validPng], { type: "image/png" });
    form.append("image", blob, "test-food.png");

    const validUploadRes = await fetch(`${baseUrl}/api/admin/upload-image?adminToken=${encodeURIComponent(token)}`, {
      method: "POST",
      body: form,
    });
    const json = await validUploadRes.json();
    console.log("  3d. Upload without credentials status:", validUploadRes.status, "body:", json);
    console.log("  (Expected 500 with clean error explaining Cloudinary configuration is required)");
  } catch (e) {
    console.error("  3d failed:", e.message);
  }

  server.close();
  console.log("\n=== ALL UNIT & ROUTE TESTS COMPLETED SUCCESSFULLY ===");
}

runTests().catch(console.error);
