import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { uploadImageToCloudinary, isCloudinaryConfigured } from '../services/storageService.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const zomatoDir = path.join(__dirname, '../../rustic charmzomato/rustic charm');

// Precise mapping of local Zomato image to database menu item ID
const UPLOAD_MAPPINGS = [
  {
    itemId: 'item-0pa3v1x4p',
    expectedName: 'Chicken Handi',
    imageFile: 'chicken handi.jpg',
  },
  {
    itemId: 'item-fn7hl5rgx',
    expectedName: 'Paneer Butter Masala',
    imageFile: 'paneer butter masala.jpg',
  },
  {
    itemId: '54db76ae-bd8b-4bed-9140-ed8fad25002a',
    expectedName: 'Mutton Curry',
    imageFile: 'mutton curry.jpg',
  },
  {
    itemId: 'item-5s3zha9pc',
    expectedName: 'Mango Juice',
    imageFile: 'mango juice.jpg',
  },
  {
    itemId: 'item-oprnq5t6t',
    expectedName: 'Watermelon Juice',
    imageFile: 'watermelon juice.jpg',
  },
  {
    itemId: 'item-y7dh31omz',
    expectedName: 'Veg Hakka Noodles',
    imageFile: 'veg hakka noodles.jpg',
  },
  {
    itemId: 'c6c76ea2-7079-484a-8f5f-5644eee727ab',
    expectedName: 'veg fried rice',
    imageFile: 'veg fried rice.jpg',
  },
  {
    itemId: 'item-hxyq5j8lx',
    expectedName: 'Vegetable Thali',
    imageFile: 'veg thali.jpg',
  },
  {
    itemId: 'item-scb01ymu8',
    expectedName: 'Butter Garlic Prawns',
    imageFile: 'prawns butter garlic.jpg',
  },
  {
    itemId: 'item-5j7nnmod1',
    expectedName: 'Hakka Noodles- Non vegetarian',
    imageFile: 'chicken hakka noodles.jpg',
  },
  {
    itemId: 'c750673c-096b-4fec-b302-f8fca6c39e54',
    expectedName: 'chicken szechuan noodles',
    imageFile: 'chicken schezwan noodles.jpg',
  },
  {
    itemId: 'item-18d555hyr',
    expectedName: 'Non-Vegetarian Szechuan Fried Rice',
    imageFile: 'chicken schezwan fried rice.jpg',
  },
  {
    itemId: 'item-w0g8oav89',
    expectedName: 'Hummus & Pitta',
    imageFile: 'hummus pita.jpg',
  },
  {
    itemId: 'item-cbakrs267',
    expectedName: 'Tom Yum Soup -Non veg',
    imageFile: 'tom yum soup prawns.jpg',
  },
  {
    itemId: 'item-nc4zou8xj',
    expectedName: 'Mix Veg Raita',
    imageFile: 'veg raita.jpg',
  },
  {
    itemId: 'item-p8skqvp4s',
    expectedName: 'Crispy Chicken Dry',
    imageFile: 'chicken crispy.jpg',
  },
  {
    itemId: 'item-4qw97wc15',
    expectedName: 'Fried Rice (Multi-option)',
    imageFile: 'chicken fried rice.jpg',
  },
  {
    itemId: '56823ccf-7e74-431b-b262-d6b6f5380904',
    expectedName: 'Thali (Multi-option)',
    imageFile: 'chicken thali.jpg',
  },
];

async function runBatchUpload() {
  console.log('=== STARTING BATCH CLOUDINARY UPLOAD & DATABASE UPDATE ===\n');

  if (!isCloudinaryConfigured()) {
    throw new Error('Cloudinary credentials are not properly configured in backend/.env');
  }

  console.log(`Cloud Name configured: ${process.env.CLOUDINARY_CLOUD_NAME}`);
  console.log(`Image Source Directory: ${zomatoDir}`);
  console.log(`Items to process: ${UPLOAD_MAPPINGS.length}\n`);

  // Connect to MySQL
  const pool = mysql.createPool({
    host: 'mysql-4363837-rusticcharmbydaaom633-76de.j.aivencloud.com',
    user: 'avnadmin',
    password: process.env.DB_PASSWORD,
    database: 'defaultdb',
    port: 19138,
    ssl: { rejectUnauthorized: false },
  });

  const results = [];

  for (let i = 0; i < UPLOAD_MAPPINGS.length; i++) {
    const { itemId, expectedName, imageFile } = UPLOAD_MAPPINGS[i];
    const filePath = path.join(zomatoDir, imageFile);
    console.log(`[${i + 1}/${UPLOAD_MAPPINGS.length}] Processing "${expectedName}" (${imageFile})...`);

    if (!fs.existsSync(filePath)) {
      console.error(`  ✗ File not found: ${filePath}`);
      results.push({ itemId, name: expectedName, status: 'FAILED', reason: 'File not found' });
      continue;
    }

    try {
      const buffer = fs.readFileSync(filePath);
      console.log(`  -> Read ${buffer.length} bytes. Uploading to Cloudinary...`);

      // Upload in-memory to Cloudinary rustic-charm/menu
      const uploadResult = await uploadImageToCloudinary(buffer, {
        originalFilename: imageFile,
      });

      const cloudinaryUrl = uploadResult.url;
      console.log(`  ✓ Uploaded to Cloudinary: ${cloudinaryUrl}`);

      // Update Aiven MySQL menu_items.image_url
      const [updateRes] = await pool.query(
        'UPDATE menu_items SET image_url = ?, updated_at = NOW() WHERE id = ?',
        [cloudinaryUrl, itemId]
      );

      console.log(`  ✓ Database updated (affectedRows: ${updateRes.affectedRows})`);

      // Verify in DB
      const [rows] = await pool.query('SELECT id, name, image_url FROM menu_items WHERE id = ?', [itemId]);
      const savedUrl = rows[0]?.image_url;

      results.push({
        itemId,
        name: expectedName,
        status: 'SUCCESS',
        cloudinaryUrl: savedUrl,
      });
    } catch (err) {
      console.error(`  ✗ Failed: ${err.message}`);
      results.push({ itemId, name: expectedName, status: 'FAILED', reason: err.message });
    }
  }

  await pool.end();

  console.log('\n=== BATCH UPLOAD SUMMARY ===');
  console.table(results);

  const successful = results.filter((r) => r.status === 'SUCCESS');
  const failed = results.filter((r) => r.status === 'FAILED');
  console.log(`\nTotal: ${results.length} | Successful: ${successful.length} | Failed: ${failed.length}`);
}

runBatchUpload().catch((err) => {
  console.error('Fatal error during batch upload:', err);
  process.exit(1);
});
