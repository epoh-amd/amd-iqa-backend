/**
 * Photo Optimization Middleware for Production Environment
 * 
 * This module provides advanced photo optimization features:
 * - Automatic image compression
 * - Format conversion for better performance
 * - Thumbnail generation
 * - Progressive JPEG optimization
 * - WebP conversion support
 * - Batch processing capabilities
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

/**
 * Image optimization configuration
 */
const OPTIMIZATION_CONFIG = {
  jpeg: {
    quality: 85,
    progressive: true,
    mozjpeg: true
  },
  png: {
    quality: 90,
    compressionLevel: 8,
    progressive: true
  },
  webp: {
    quality: 80,
    effort: 6
  },
  thumbnails: {
    small: { width: 150, height: 150 },
    medium: { width: 300, height: 300 },
    large: { width: 800, height: 600 }
  },
  maxDimensions: {
    width: 2048,
    height: 2048
  },
  maxFileSize: 5 * 1024 * 1024 // 5MB
};

/**
 * Optimize image for web delivery
 * 
 * @param {string} inputPath - Input image path
 * @param {string} outputPath - Output image path
 * @param {object} options - Optimization options
 * @returns {Promise<object>} - Optimization result
 */
const optimizeImage = async (inputPath, outputPath, options = {}) => {
  try {
    const startTime = Date.now();
    const originalStats = await fs.stat(inputPath);
    
    // Get image metadata
    const metadata = await sharp(inputPath).metadata();
    
    // Determine output format
    const outputFormat = options.format || metadata.format;
    const config = { ...OPTIMIZATION_CONFIG[outputFormat], ...options };
    
    let pipeline = sharp(inputPath);
    
    // Resize if image is too large
    if (metadata.width > OPTIMIZATION_CONFIG.maxDimensions.width || 
        metadata.height > OPTIMIZATION_CONFIG.maxDimensions.height) {
      pipeline = pipeline.resize(
        OPTIMIZATION_CONFIG.maxDimensions.width,
        OPTIMIZATION_CONFIG.maxDimensions.height,
        { 
          fit: 'inside',
          withoutEnlargement: true
        }
      );
    }
    
    // Apply format-specific optimizations
    switch (outputFormat) {
      case 'jpeg':
      case 'jpg':
        pipeline = pipeline.jpeg(config);
        break;
      case 'png':
        pipeline = pipeline.png(config);
        break;
      case 'webp':
        pipeline = pipeline.webp(config);
        break;
      default:
        throw new Error(`Unsupported output format: ${outputFormat}`);
    }
    
    // Save optimized image
    await pipeline.toFile(outputPath);
    
    const optimizedStats = await fs.stat(outputPath);
    const processingTime = Date.now() - startTime;
    
    const result = {
      success: true,
      originalSize: originalStats.size,
      optimizedSize: optimizedStats.size,
      compressionRatio: ((originalStats.size - optimizedStats.size) / originalStats.size * 100).toFixed(2),
      processingTimeMs: processingTime,
      dimensions: {
        original: { width: metadata.width, height: metadata.height },
        optimized: await getImageDimensions(outputPath)
      },
      format: {
        original: metadata.format,
        optimized: outputFormat
      }
    };
    
    if (process.env.NODE_ENV !== 'production') {
      console.log('📸 Image optimized:', {
        file: path.basename(inputPath),
        sizeBefore: `${(originalStats.size / 1024).toFixed(2)}KB`,
        sizeAfter: `${(optimizedStats.size / 1024).toFixed(2)}KB`,
        compression: `${result.compressionRatio}%`,
        time: `${processingTime}ms`
      });
    }
    
    return result;
    
  } catch (error) {
    return {
      success: false,
      error: error.message,
      inputPath,
      outputPath
    };
  }
};

/**
 * Generate thumbnails for an image
 * 
 * @param {string} inputPath - Input image path
 * @param {string} outputDir - Output directory for thumbnails
 * @param {string} baseName - Base name for thumbnail files
 * @returns {Promise<object>} - Thumbnail generation result
 */
const generateThumbnails = async (inputPath, outputDir, baseName) => {
  try {
    const thumbnails = {};
    const tasks = [];
    
    // Ensure output directory exists
    await fs.mkdir(outputDir, { recursive: true });
    
    for (const [size, dimensions] of Object.entries(OPTIMIZATION_CONFIG.thumbnails)) {
      const thumbnailPath = path.join(outputDir, `${baseName}_${size}.webp`);
      
      const task = sharp(inputPath)
        .resize(dimensions.width, dimensions.height, {
          fit: 'cover',
          position: 'center'
        })
        .webp({ quality: 80 })
        .toFile(thumbnailPath)
        .then(async () => {
          const stats = await fs.stat(thumbnailPath);
          thumbnails[size] = {
            path: thumbnailPath,
            size: stats.size,
            dimensions
          };
        });
      
      tasks.push(task);
    }
    
    await Promise.all(tasks);
    
    return {
      success: true,
      thumbnails,
      count: Object.keys(thumbnails).length
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
};

/**
 * Convert image to WebP format for better compression
 * 
 * @param {string} inputPath - Input image path
 * @param {string} outputPath - Output WebP path
 * @returns {Promise<object>} - Conversion result
 */
const convertToWebP = async (inputPath, outputPath) => {
  try {
    const originalStats = await fs.stat(inputPath);
    
    await sharp(inputPath)
      .webp(OPTIMIZATION_CONFIG.webp)
      .toFile(outputPath);
    
    const webpStats = await fs.stat(outputPath);
    
    return {
      success: true,
      originalSize: originalStats.size,
      webpSize: webpStats.size,
      savings: ((originalStats.size - webpStats.size) / originalStats.size * 100).toFixed(2)
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
};

/**
 * Get image dimensions
 * 
 * @param {string} imagePath - Image file path
 * @returns {Promise<object>} - Image dimensions
 */
const getImageDimensions = async (imagePath) => {
  try {
    const metadata = await sharp(imagePath).metadata();
    return {
      width: metadata.width,
      height: metadata.height
    };
  } catch (error) {
    return null;
  }
};

/**
 * Batch optimize images in a directory
 * 
 * @param {string} inputDir - Input directory
 * @param {string} outputDir - Output directory
 * @param {object} options - Optimization options
 * @returns {Promise<object>} - Batch optimization result
 */
const batchOptimize = async (inputDir, outputDir, options = {}) => {
  try {
    const files = await fs.readdir(inputDir);
    const imageFiles = files.filter(file => 
      /\.(jpg|jpeg|png|gif|webp)$/i.test(file)
    );
    
    await fs.mkdir(outputDir, { recursive: true });
    
    const results = [];
    let totalOriginalSize = 0;
    let totalOptimizedSize = 0;
    
    for (const file of imageFiles) {
      const inputPath = path.join(inputDir, file);
      const outputPath = path.join(outputDir, file);
      
      const result = await optimizeImage(inputPath, outputPath, options);
      results.push({
        file,
        ...result
      });
      
      if (result.success) {
        totalOriginalSize += result.originalSize;
        totalOptimizedSize += result.optimizedSize;
      }
    }
    
    return {
      success: true,
      processedFiles: imageFiles.length,
      results,
      totalSavings: {
        bytes: totalOriginalSize - totalOptimizedSize,
        percentage: totalOriginalSize > 0 ? 
          ((totalOriginalSize - totalOptimizedSize) / totalOriginalSize * 100).toFixed(2) : 0
      }
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
};

/**
 * Middleware for automatic photo optimization on upload
 * 
 * @param {object} options - Optimization options
 * @returns {function} - Express middleware
 */
const createOptimizationMiddleware = (options = {}) => {
  return async (req, res, next) => {
    // Only process if files were uploaded
    if (!req.files && !req.file) {
      return next();
    }
    
    const files = req.files || [req.file];
    const optimizedFiles = [];
    
    try {
      for (const file of files) {
        // Only optimize images
        if (!file.mimetype.startsWith('image/')) {
          optimizedFiles.push(file);
          continue;
        }
        
        const originalPath = file.path;
        const optimizedPath = originalPath.replace(/(\.[^.]+)$/, '_optimized$1');
        
        const result = await optimizeImage(originalPath, optimizedPath, options);
        
        if (result.success) {
          // Replace original with optimized version
          await fs.unlink(originalPath);
          await fs.rename(optimizedPath, originalPath);
          
          // Update file object with new stats
          const stats = await fs.stat(originalPath);
          file.size = stats.size;
          file.optimized = true;
          file.compressionRatio = result.compressionRatio;
        }
        
        optimizedFiles.push(file);
      }
      
      // Update request with optimized files
      if (req.files) {
        req.files = optimizedFiles;
      } else {
        req.file = optimizedFiles[0];
      }
      
      next();
      
    } catch (error) {
      console.error('Photo optimization error:', error);
      // Continue without optimization on error
      next();
    }
  };
};

module.exports = {
  optimizeImage,
  generateThumbnails,
  convertToWebP,
  getImageDimensions,
  batchOptimize,
  createOptimizationMiddleware,
  OPTIMIZATION_CONFIG
};
