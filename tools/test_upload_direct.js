import fetch from 'node-fetch';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
    const token = 'rustic-charm-admin-token';
    const url = `https://rustic-charm-backend.onrender.com/api/admin/upload-image?adminToken=${token}`;

    const form = new FormData();
    // Create a small mock text file, but name it .png so mimetype filter or content doesn't fail
    const filePath = path.join(__dirname, 'test.png');
    fs.writeFileSync(filePath, 'fake image content');

    form.append('image', fs.createReadStream(filePath));

    console.log('Sending request to:', url);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                ...form.getHeaders(),
                'Authorization': `Bearer ${token}`,
                'x-admin-token': token,
            },
            body: form,
        });

        const status = res.status;
        const text = await res.text();
        console.log('Response status:', status);
        console.log('Response body:', text);
    } catch (err) {
        console.error('Request failed with error:', err.message);
    } finally {
        try {
            fs.unlinkSync(filePath);
        } catch (e) { }
    }
}

run();
