const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('./restaurant.db');
db.all('SELECT * FROM categories limit 5', (err, rows) => {
  if (err) console.error(err);
  console.log(JSON.stringify(rows, null, 2));
  db.close();
});
