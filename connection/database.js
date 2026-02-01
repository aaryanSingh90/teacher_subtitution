// connection/database.js
const mysql = require('mysql2/promise'); // Using 'mysql2/promise' for async/await support

// 
// 🚨🚨🚨 REPLACE WITH YOUR ACTUAL DATABASE CREDENTIALS 🚨🚨🚨
//
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',   // e.g., 'root'
    password: 'bhopal90', // Your database password
    database: 'TT',  // The name of your database
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Test the connection immediately (optional, but good practice)
pool.getConnection()
    .then(connection => {
        console.log('✅ Database pool connected successfully.');
        connection.release();
    })
    .catch(err => {
        console.error('❌ FATAL ERROR: Database connection failed. Check credentials and server status.', err);
        // Exiting the process on a database failure ensures the server doesn't start broken.
        process.exit(1); 
    });


// Export the pool so it can be used throughout server.js
module.exports = pool;