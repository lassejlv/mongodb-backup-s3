import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { S3Client } from "bun";
import { CronJob } from "cron";
import { createGzip } from "zlib";

async function backupMongoDB(): Promise<string> {
  const dbHost = process.env.DB_HOST;
  const dbPort = process.env.DB_PORT || "27017";
  const dbUser = process.env.DB_USER;
  const dbPass = process.env.DB_PASS;
  const dbAuthSource = process.env.DB_AUTH_SOURCE || "admin";
  const dbName = process.env.DB_NAME;

  if (!dbHost) {
    throw new Error("DB_HOST environment variable is not set");
  }

  if (!dbName) {
    throw new Error("DB_NAME environment variable is not set");
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\./g, "-");

  const backupDir = path.join(process.cwd(), "backups");
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir);
  }

  try {
    console.log(
      `[${new Date().toISOString()}] Starting backup of database '${dbName}'...`,
    );
    console.log("Connecting to MongoDB...");

    let connectionString = `mongodb://${dbHost}:${dbPort}/${dbName}`;

    if (dbUser && dbPass) {
      connectionString = `mongodb://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPass)}@${dbHost}:${dbPort}/${dbName}?authSource=${dbAuthSource}`;
    }

    await mongoose.connect(connectionString);

    console.log(`Connected to database '${dbName}'. Starting backup...`);

    const backupFileName = `${dbName}_${timestamp}.json.gz`;
    const backupFilePath = path.join(backupDir, backupFileName);

    const gzip = createGzip();
    const fileStream = fs.createWriteStream(backupFilePath);
    gzip.pipe(fileStream);

    const collections = await mongoose.connection.db?.collections()!;

    gzip.write("[\n");

    let isFirst = true;

    for (const collection of collections) {
      const collectionName = collection.collectionName;
      console.log(`Backing up collection: ${collectionName}`);

      // Get total count for this collection
      const totalCount = await collection.countDocuments();
      console.log(`Total documents in ${collectionName}: ${totalCount}`);

      // Process in batches
      const batchSize = 1000;
      let processedCount = 0;

      while (processedCount < totalCount) {
        // Create a new cursor for each batch
        const docs = await collection
          .find({})
          .skip(processedCount)
          .limit(batchSize)
          .toArray();

        if (docs.length === 0) break;

        for (const doc of docs) {
          doc._collection = collectionName;

          if (!isFirst) {
            gzip.write(",\n");
          } else {
            isFirst = false;
          }

          gzip.write(JSON.stringify(doc));
        }

        processedCount += docs.length;
        console.log(
          `Processed ${processedCount}/${totalCount} documents from ${collectionName}`,
        );
      }

      console.log(`Completed backup of collection: ${collectionName}`);
    }

    gzip.write("\n]");
    gzip.end();

    // Wait for everything to finish
    await new Promise<void>((resolve) => {
      fileStream.on("finish", () => {
        resolve();
      });
    });

    console.log(`Backup completed successfully!`);
    return backupFilePath;
  } catch (error) {
    console.error("Backup operation failed:", error);
    throw error;
  } finally {
    await mongoose.disconnect();
  }
}

async function uploadToS3(filePath: string): Promise<string> {
  const s3 = new S3Client();

  const fileName = path.basename(filePath);
  const s3Key = `mongodb-backups/${fileName}`;

  console.log(`Uploading backup to S3: ${s3Key}`);

  const file = Bun.file(filePath);
  const s3File = s3.file(s3Key);

  await s3File.write(file, {
    type: "application/gzip",
  });

  console.log("Upload to S3 completed successfully!");

  return s3Key;
}

async function cleanupOldBackups(maxAgeInDays: number = 30): Promise<void> {
  const backupDir = path.join(process.cwd(), "backups");
  if (!fs.existsSync(backupDir)) return;

  const files = fs.readdirSync(backupDir);
  const now = Date.now();
  const maxAge = maxAgeInDays * 24 * 60 * 60 * 1000;

  console.log(`Cleaning up backups older than ${maxAgeInDays} days...`);

  for (const file of files) {
    const filePath = path.join(backupDir, file);
    const stats = fs.statSync(filePath);
    const fileAge = now - stats.mtime.getTime();

    if (fileAge > maxAge) {
      console.log(`Removing old backup: ${file}`);
      fs.unlinkSync(filePath);
    }
  }
}

async function runBackup(): Promise<void> {
  try {
    console.log(`[${new Date().toISOString()}] Starting backup job...`);

    const backupPath = await backupMongoDB();
    console.log(`Backup created at: ${backupPath}`);

    const s3Key = await uploadToS3(backupPath);
    console.log(`Backup uploaded to S3: ${s3Key}`);

    const retentionDays = parseInt(process.env.BACKUP_RETENTION_DAYS || "30");
    await cleanupOldBackups(retentionDays);

    console.log(
      `[${new Date().toISOString()}] Backup job completed successfully.`,
    );
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Backup job failed:`, error);
  }
}

runBackup();

// Set up cron job
const cronSchedule = process.env.BACKUP_CRON || "0 */6 * * *"; // Every 6 hours by default
const job = new CronJob(cronSchedule, runBackup, null, true);

console.log(
  `[${new Date().toISOString()}] MongoDB backup service started with schedule: ${cronSchedule}`,
);
console.log(`Next backup scheduled for: ${job.nextDate().toLocaleString()}`);
