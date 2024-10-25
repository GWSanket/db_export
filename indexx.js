const mysql = require('mysql');
const fs = require('fs');
const path = require('path');

// Database configuration
const dbConfig = {
    host: 'prod-garageworks.ccfcnwudqgxr.ap-south-1.rds.amazonaws.com', // Your DB host
    user: 'gw_admin', // Your DB username
    password: 'Xopvum-vuwrax-nyxse3', // Your DB password
    database: 'beta', // Your DB name
};

// Directory for saving the backup file
const backupDir = path.join(__dirname, 'backups');

// Ensure the backup directory exists
if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
}

// Backup file path with timestamp
const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
const exportFilePath = path.join(backupDir, `${dbConfig.database}-backup-${timestamp}.sql`);

// Connect to the database
const connection = mysql.createConnection(dbConfig);

connection.connect((err) => {
    if (err) {
        console.error('Error connecting to the database:', err.message);
        return;
    }
    console.log('Connected to the database.');

    // Start the export process
    exportDatabase(connection, dbConfig.database, exportFilePath, () => {
        console.log('Database export completed successfully.');
        connection.end();
    });
});

// Function to check if a value is a valid date
function isValidDate(value) {
    return !isNaN(Date.parse(value));
}

// Function to export the database
function exportDatabase(connection, databaseName, filePath, callback) {
    // Open the file to write the export
    const fileStream = fs.createWriteStream(filePath);

    // Write the database creation statement
    fileStream.write(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\`;\nUSE \`${databaseName}\`;\n\n`);

    // Get all table names
    connection.query('SHOW TABLES', (err, tables) => {
        if (err) {
            console.error('Error fetching tables:', err.message);
            fileStream.end();
            return;
        }

        let pendingTables = tables.length;

        tables.forEach((row) => {
            const tableName = row[`Tables_in_${databaseName}`];

            // Export the table structure
            connection.query(`SHOW CREATE TABLE \`${tableName}\``, (err, createTableResult) => {
                if (err) {
                    console.error(`Error fetching table structure for ${tableName}:`, err.message);
                    if (--pendingTables === 0) {
                        fileStream.end();
                        callback();
                    }
                    return;
                }

                const createTableSQL = createTableResult[0]['Create Table'];
                fileStream.write(`${createTableSQL};\n\n`);

                // Get column metadata for date and timestamp formatting
                connection.query(`SHOW COLUMNS FROM \`${tableName}\``, (err, columns) => {
                    if (err) {
                        console.error(`Error fetching column information for ${tableName}:`, err.message);
                        if (--pendingTables === 0) {
                            fileStream.end();
                            callback();
                        }
                        return;
                    }

                    const dateColumns = columns.filter(col => col.Type.includes('date')).map(col => col.Field);
                    const timestampColumns = columns.filter(col => col.Type.includes('timestamp')).map(col => col.Field);

                    // Export the table data
                    connection.query(`SELECT * FROM \`${tableName}\``, (err, rows) => {
                        if (err) {
                            console.error(`Error fetching data for ${tableName}:`, err.message);
                            if (--pendingTables === 0) {
                                fileStream.end();
                                callback();
                            }
                            return;
                        }

                        if (rows.length > 0) {
                            const columnsList = Object.keys(rows[0]).map((col) => `\`${col}\``).join(', ');
                            const values = rows.map((row) => {
                                return `(${Object.keys(row).map((col) => {
                                    const val = row[col];
                                    if (val === null) return 'NULL';

                                    if (dateColumns.includes(col) && isValidDate(val)) {
                                        // Format as 'YYYY-MM-DD' for date columns
                                        const date = new Date(val);
                                        const formattedDate = date.toISOString().split('T')[0];
                                        return `'${formattedDate}'`;
                                    }

                                    if (timestampColumns.includes(col) && isValidDate(val)) {
                                        // Format as 'YYYY-MM-DD HH:MM:SS' for timestamp columns
                                        const date = new Date(val);
                                        const year = date.getFullYear();
                                        const month = String(date.getMonth() + 1).padStart(2, '0');
                                        const day = String(date.getDate()).padStart(2, '0');
                                        const hours = String(date.getHours()).padStart(2, '0');
                                        const minutes = String(date.getMinutes()).padStart(2, '0');
                                        const seconds = String(date.getSeconds()).padStart(2, '0');
                                        const formattedTimestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
                                        return `'${formattedTimestamp}'`;
                                    }

                                    if (typeof val === 'string') {
                                        // Escape special characters in strings
                                        return `'${val.replace(/'/g, "''")}'`;
                                    } else {
                                        // For numbers and other data types
                                        return val;
                                    }
                                }).join(', ')})`;
                            }).join(',\n');

                            const insertSQL = `INSERT INTO \`${tableName}\` (${columnsList}) VALUES\n${values};\n\n`;
                            fileStream.write(insertSQL);
                        } else {
                            fileStream.write(`-- No data for table ${tableName}\n\n`);
                        }

                        if (--pendingTables === 0) {
                            fileStream.end();
                            callback();
                        }
                    });
                });
            });
        });
    });
}
