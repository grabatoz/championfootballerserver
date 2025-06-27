import multer from '@koa/multer';
import path from 'path';
import { ApiError } from '../utils/error';
interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  destination: string;
  filename: string;
  path: string;
  buffer: Buffer;
}
// Configure storage
const storage = multer.diskStorage({
  destination: (req: any, file: MulterFile, cb: (error: Error | null, destination: string) => void) => {
    // ✅ Always use absolute path
    cb(null, path.resolve(process.cwd(), 'uploads/'));
  },
  filename: (req: any, file: MulterFile, cb: (error: Error | null, filename: string) => void) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

// File filter
const fileFilter = (req: any, file: any, cb: any) => {
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new ApiError(400, 'Only image files are allowed!'));
  }
};

// Export multer instance
export const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB max
  }
});
