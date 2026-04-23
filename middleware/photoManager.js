/**
 * Production Photo Management Service
 * 
 * This service provides comprehensive photo management for the AMD Smart Hand system:
 * - Photo upload handling with validation
 * - Automatic optimization and compression
 * - Thumbnail generation
 * - Photo serving with caching
 * - Cleanup and maintenance operations
 * - Performance monitoring
 * - Error recovery and fallbacks
 */

const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { 
  processUploadedPhoto, 
  validateImageFile, 
  generateFileUrl,
  cleanupOldFiles,
  getDirectoryStats
} = require('./fileHandler');
const { 
  optimizeImage, 
  generateThumbnails, 
  createOptimizationMiddleware 
} = require('./photoOptimizer');

class PhotoManager {
  constructor(uploadsDir, config = {}) {
    this.uploadsDir = uploadsDir;
    this.config = {
      enableOptimization: config.enableOptimization !== false,
      enableThumbnails: config.enableThumbnails !== false,
      autoCleanup: config.autoCleanup !== false,
      cleanupIntervalMs: config.cleanupIntervalMs || 24 * 60 * 60 * 1000, // 24 hours
      maxAge: config.maxAge || 30 * 24 * 60 * 60 * 1000, // 30 days
      ...config
    };
    
    this.stats = {
      uploadsCount: 0,
      totalSize: 0,
      optimizedCount: 0,
      errorCount: 0,
      lastCleanup: null
    };
    
    // Initialize cleanup timer if enabled
    if (this.config.autoCleanup) {
      this.startCleanupTimer();
    }
    
    console.log('📸 PhotoManager initialized:', {
      uploadsDir: this.uploadsDir,
      optimization: this.config.enableOptimization,
      thumbnails: this.config.enableThumbnails,
      autoCleanup: this.config.autoCleanup
    });
  }
  
  /**
   * Process uploaded photo with optimization and validation
   * 
   * @param {object} file - Multer file object
   * @param {object} options - Processing options
   * @returns {Promise<object>} - Processing result
   */
  async processUpload(file, options = {}) {
    const startTime = Date.now();
    
    try {
      // Basic file processing
      const fileInfo = await processUploadedPhoto(file, this.uploadsDir);
      
      let optimizationResult = null;
      let thumbnailResult = null;
      
      // Optimize image if enabled
      if (this.config.enableOptimization && !options.skipOptimization) {
        const optimizedPath = file.path.replace(/(\.[^.]+)$/, '_opt$1');
        optimizationResult = await optimizeImage(file.path, optimizedPath, options.optimization);
        
        if (optimizationResult.success) {
          // Replace original with optimized version
          await fs.unlink(file.path);
          await fs.rename(optimizedPath, file.path);
          
          fileInfo.size = optimizationResult.optimizedSize;
          fileInfo.optimized = true;
          fileInfo.compressionRatio = optimizationResult.compressionRatio;
          
          this.stats.optimizedCount++;
        }
      }
      
      // Generate thumbnails if enabled
      if (this.config.enableThumbnails && !options.skipThumbnails) {
        const thumbnailDir = path.join(this.uploadsDir, 'thumbnails');
        const baseName = path.parse(file.filename).name;
        
        thumbnailResult = await generateThumbnails(file.path, thumbnailDir, baseName);
        
        if (thumbnailResult.success) {
          fileInfo.thumbnails = thumbnailResult.thumbnails;
        }
      }
      
      // Update statistics
      this.stats.uploadsCount++;
      this.stats.totalSize += fileInfo.size;
      
      const processingTime = Date.now() - startTime;
      
      return {
        success: true,
        file: fileInfo,
        optimization: optimizationResult,
        thumbnails: thumbnailResult,
        processingTimeMs: processingTime,
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      this.stats.errorCount++;
      
      // Clean up file on error
      try {
        if (fsSync.existsSync(file.path)) {
          await fs.unlink(file.path);
        }
      } catch (cleanupError) {
        console.error('Failed to cleanup file on error:', cleanupError.message);
      }
      
      return {
        success: false,
        error: error.message,
        file: file.filename,
        processingTimeMs: Date.now() - startTime
      };
    }
  }
  
  /**
   * Get photo URL with fallback handling
   * 
   * @param {string} filePath - Database file path
   * @param {string} baseUrl - Base URL
   * @param {object} options - URL options
   * @returns {Promise<string>} - Photo URL or fallback
   */
  async getPhotoUrl(filePath, baseUrl, options = {}) {
    try {
      if (!filePath) {
        return this.getFallbackUrl(options.fallbackType);
      }
      
      const absolutePath = path.join(this.uploadsDir, filePath.replace('uploads/', ''));
      
      // Check if file exists
      const exists = fsSync.existsSync(absolutePath);
      if (!exists) {
        console.warn(`Photo not found: ${filePath}`);
        return this.getFallbackUrl(options.fallbackType);
      }
      
      // Return thumbnail URL if requested and available
      if (options.thumbnail) {
        const thumbnailUrl = await this.getThumbnailUrl(filePath, baseUrl, options.thumbnail);
        if (thumbnailUrl) return thumbnailUrl;
      }
      
      return generateFileUrl(filePath, baseUrl);
      
    } catch (error) {
      console.error('Error generating photo URL:', error);
      return this.getFallbackUrl(options.fallbackType);
    }
  }
  
  /**
   * Get thumbnail URL
   * 
   * @param {string} filePath - Original file path
   * @param {string} baseUrl - Base URL
   * @param {string} size - Thumbnail size (small, medium, large)
   * @returns {Promise<string|null>} - Thumbnail URL or null
   */
  async getThumbnailUrl(filePath, baseUrl, size = 'medium') {
    try {
      const baseName = path.parse(filePath).name;
      const thumbnailPath = `uploads/thumbnails/${baseName}_${size}.webp`;
      const absolutePath = path.join(this.uploadsDir, 'thumbnails', `${baseName}_${size}.webp`);
      
      if (fsSync.existsSync(absolutePath)) {
        return generateFileUrl(thumbnailPath, baseUrl);
      }
      
      return null;
      
    } catch (error) {
      console.error('Error getting thumbnail URL:', error);
      return null;
    }
  }
  
  /**
   * Get fallback URL for missing photos
   * 
   * @param {string} type - Fallback type
   * @returns {string} - Fallback URL
   */
  getFallbackUrl(type = 'default') {
    const fallbacks = {
      default: '/static/images/photo-placeholder.png',
      user: '/static/images/user-placeholder.png',
      product: '/static/images/product-placeholder.png',
      error: '/static/images/error-placeholder.png'
    };
    
    return fallbacks[type] || fallbacks.default;
  }
  
  /**
   * Perform maintenance operations
   * 
   * @returns {Promise<object>} - Maintenance result
   */
  async performMaintenance() {
    try {
      const maintenanceStart = Date.now();
      
      // Clean up old files
      const cleanupResult = await cleanupOldFiles(this.uploadsDir, this.config.maxAge);
      
      // Clean up orphaned thumbnails
      const thumbnailDir = path.join(this.uploadsDir, 'thumbnails');
      let thumbnailCleanup = { deletedCount: 0 };
      
      if (fsSync.existsSync(thumbnailDir)) {
        thumbnailCleanup = await this.cleanupOrphanedThumbnails(thumbnailDir);
      }
      
      // Update directory statistics
      const dirStats = await getDirectoryStats(this.uploadsDir);
      
      this.stats.lastCleanup = new Date().toISOString();
      
      const maintenanceTime = Date.now() - maintenanceStart;
      
      const result = {
        success: true,
        cleanup: cleanupResult,
        thumbnailCleanup,
        directoryStats: dirStats,
        maintenanceTimeMs: maintenanceTime,
        timestamp: this.stats.lastCleanup
      };
      
      if (process.env.NODE_ENV !== 'production') {
        console.log('🧹 Maintenance completed:', {
          filesDeleted: cleanupResult.deletedCount + thumbnailCleanup.deletedCount,
          spaceFreed: cleanupResult.totalSizeFreed,
          currentFiles: dirStats.fileCount,
          currentSize: dirStats.formattedSize,
          time: `${maintenanceTime}ms`
        });
      }
      
      return result;
      
    } catch (error) {
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }
  
  /**
   * Clean up orphaned thumbnails
   * 
   * @param {string} thumbnailDir - Thumbnail directory
   * @returns {Promise<object>} - Cleanup result
   */
  async cleanupOrphanedThumbnails(thumbnailDir) {
    try {
      const thumbnails = await fs.readdir(thumbnailDir);
      let deletedCount = 0;
      
      for (const thumbnail of thumbnails) {
        // Extract original filename from thumbnail name
        const baseName = thumbnail.replace(/_(?:small|medium|large)\.webp$/, '');
        
        // Check if original file exists
        const originalExists = await this.findOriginalFile(baseName);
        
        if (!originalExists) {
          const thumbnailPath = path.join(thumbnailDir, thumbnail);
          await fs.unlink(thumbnailPath);
          deletedCount++;
        }
      }
      
      return { deletedCount };
      
    } catch (error) {
      return { deletedCount: 0, error: error.message };
    }
  }
  
  /**
   * Find original file for thumbnail
   * 
   * @param {string} baseName - Base filename
   * @returns {Promise<boolean>} - Whether original file exists
   */
  async findOriginalFile(baseName) {
    const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    
    for (const ext of extensions) {
      const filePath = path.join(this.uploadsDir, `${baseName}${ext}`);
      if (fsSync.existsSync(filePath)) {
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * Start automatic cleanup timer
   */
  startCleanupTimer() {
    setInterval(async () => {
      await this.performMaintenance();
    }, this.config.cleanupIntervalMs);
  }
  
  /**
   * Get current statistics
   * 
   * @returns {object} - Current statistics
   */
  getStats() {
    return {
      ...this.stats,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    };
  }
  
  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      uploadsCount: 0,
      totalSize: 0,
      optimizedCount: 0,
      errorCount: 0,
      lastCleanup: null
    };
  }
}

/**
 * Create Express middleware for photo upload handling
 * 
 * @param {PhotoManager} photoManager - Photo manager instance
 * @param {object} options - Middleware options
 * @returns {function} - Express middleware
 */
const createPhotoUploadMiddleware = (photoManager, options = {}) => {
  return async (req, res, next) => {
    // Skip if no files uploaded
    if (!req.files && !req.file) {
      return next();
    }
    
    const files = req.files || [req.file];
    const processedFiles = [];
    
    try {
      for (const file of files) {
        // Only process image files
        if (!file.mimetype.startsWith('image/')) {
          processedFiles.push({
            success: false,
            error: 'Not an image file',
            file: file.filename
          });
          continue;
        }
        
        const result = await photoManager.processUpload(file, options);
        processedFiles.push(result);
      }
      
      // Add processing results to request
      req.photoProcessing = {
        results: processedFiles,
        success: processedFiles.every(r => r.success),
        count: processedFiles.length
      };
      
      next();
      
    } catch (error) {
      console.error('Photo upload middleware error:', error);
      
      req.photoProcessing = {
        results: [],
        success: false,
        error: error.message
      };
      
      next();
    }
  };
};

module.exports = {
  PhotoManager,
  createPhotoUploadMiddleware
};
