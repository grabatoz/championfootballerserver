const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const admZip = require('adm-zip'); // Let's see if we have adm-zip or if we can use another method

try {
  const filePath = 'C:\\Users\\tech solutionor\\Downloads\\CF PD Notes (1).xlsx';
  const zip = new admZip(filePath);
  const zipEntries = zip.getEntries();
  
  console.log("Zip Entries:");
  zipEntries.forEach(entry => {
    console.log(entry.entryName);
    if (entry.entryName.includes('sharedStrings') || entry.entryName.includes('sheet')) {
      const text = entry.getData().toString('utf8');
      console.log(`--- Content of ${entry.entryName} (first 500 chars) ---`);
      console.log(text.substring(0, 500));
    }
  });
} catch (err) {
  console.log("Error reading zip:", err.message);
}
