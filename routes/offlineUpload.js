const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');
const router = express.Router();

// Import database configuration - get the global pool
const { getGlobalPool } = require('../utils/database');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '..', 'uploads', 'offline-uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const originalName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `offline-upload-${timestamp}-${originalName}`);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
      'application/vnd.ms-excel', // .xls
      'text/csv' // .csv
    ];
    if (allowedTypes.includes(file.mimetype) || file.originalname.match(/\.(xlsx|xls|csv)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel files (.xlsx, .xls) and CSV files are allowed'));
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

/**
 * Get template data from database for Excel generation
 */
router.get('/template/data', async (req, res) => {
  try {
    const db = getGlobalPool();
    const connection = await db.promise().getConnection();
    
    // Get sample data from recent builds (limit to 3 most recent)
    const [sampleBuilds] = await connection.execute(`
      SELECT chassis_sn, jira_ticket_no, location, build_engineer, is_custom_config,
             project_name, system_pn, platform_type, manufacturer, chassis_type,
             bmc_name, bmc_mac, mb_sn, ethernet_mac, cpu_socket, cpu_vendor,
             cpu_p0_sn, cpu_p0_socket_date_code, cpu_p1_sn, cpu_p1_socket_date_code,
             cpu_program_name, m2_pn, m2_sn, dimm_pn, dimm_qty,
             visual_inspection_status, visual_inspection_notes,
             boot_status, boot_notes, dimms_detected_status, dimms_detected_notes,
             lom_working_status, lom_working_notes, fpy_status, problem_description,
             can_continue, status, bios_version, scm_fpga_version, hpm_fpga_version, bmc_version
      FROM builds 
      ORDER BY created_at DESC 
      LIMIT 3
    `);
    
    // Get dropdown options
    const [locations] = await connection.execute(`
      SELECT DISTINCT location FROM builds WHERE location IS NOT NULL AND location != '' ORDER BY location
    `);
    
    // Get system part numbers for dropdown
    const [systemPartNumbers] = await connection.execute(`
      SELECT DISTINCT system_pn, platform_type, manufacturer, chassis_type 
      FROM builds 
      WHERE system_pn IS NOT NULL AND system_pn != '' 
      ORDER BY system_pn
    `);
    
    // Get M.2 part numbers from part_numbers table
    const [m2PartNumbers] = await connection.execute(`
      SELECT part_number FROM part_numbers WHERE type = 'Drive' ORDER BY part_number
    `);
    
    const [cpuSockets] = await connection.execute(`
      SELECT DISTINCT cpu_socket FROM builds WHERE cpu_socket IS NOT NULL AND cpu_socket != '' ORDER BY cpu_socket
    `);
    
    const [cpuVendors] = await connection.execute(`
      SELECT DISTINCT cpu_vendor FROM builds WHERE cpu_vendor IS NOT NULL AND cpu_vendor != '' ORDER BY cpu_vendor
    `);
    
    // Get failure modes with categories
    const [failureModes] = await connection.execute(`
      SELECT failure_mode, failure_category 
      FROM failure_mode_category_map 
      ORDER BY failure_category, failure_mode
    `);
    
    connection.release();
    
    const templateData = {
      sampleBuilds: sampleBuilds,
      dropdownOptions: {
        locations: locations.map(row => row.location),
        systemPartNumbers: systemPartNumbers.map(row => ({
          partNumber: row.system_pn,
          platformType: row.platform_type,
          manufacturer: row.manufacturer,
          chassisType: row.chassis_type
        })),
        m2PartNumbers: m2PartNumbers.map(row => row.part_number),
        cpuSockets: cpuSockets.map(row => row.cpu_socket),
        cpuVendors: cpuVendors.map(row => row.cpu_vendor),
        failureModes: failureModes.map(row => ({
          mode: row.failure_mode,
          category: row.failure_category
        })),
        customConfig: ['Yes', 'No'],
        testStatuses: ['Pass', 'Fail', 'N/A'],
        fpyStatuses: ['Pass', 'Fail'],
        buildStatuses: ['Complete', 'In Progress', 'Fail']
      }
    };
    
    res.json(templateData);
    
  } catch (error) {
    console.error('Error getting template data:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error getting template data' 
    });
  }
});

/**
 * Download manual template from templates folder
 */
router.get('/template/download', async (req, res) => {
  try {
    const templatePath = path.join(__dirname, '..', 'templates', 'build-entry-template.xlsx');
    
    // Check if the manual template exists
    if (!fs.existsSync(templatePath)) {
      console.error('Manual template not found at:', templatePath);
      return res.status(404).json({ 
        success: false, 
        message: 'Template file not found. Please ensure build-entry-template.xlsx exists in templates folder.' 
      });
    }
    
    console.log('Serving manual template from templates folder...');
    
    // Set appropriate headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="AMD_IQA_Build_Entry_Template.xlsx"');
    
    // Send the static file directly
    res.download(templatePath, 'AMD_IQA_Build_Entry_Template.xlsx', (err) => {
      if (err) {
        console.error('Error downloading template:', err);
        res.status(500).json({ 
          success: false, 
          message: 'Error downloading template file' 
        });
      }
    });
    
  } catch (error) {
    console.error('Error serving template:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error serving template file' 
    });
  }
});

/**
 * Upload and process offline build entries
 */
router.post('/upload', upload.single('file'), async (req, res) => {
  const db = getGlobalPool();
  const connection = await db.promise().getConnection();
  
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        message: 'No file uploaded' 
      });
    }

    console.log('Processing offline upload file:', req.file.filename);
    
    // Parse the uploaded file
    const workbook = XLSX.readFile(req.file.path);
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    
    if (data.length < 2) {
      throw new Error('File must contain at least a header row and one data row');
    }
    
    const headers = data[0];
    const rows = data.slice(1).filter(row => row.some(cell => cell !== undefined && cell !== ''));
    
    console.log(`Processing ${rows.length} build entries`);
    
    // Validate headers
    const requiredHeaders = [
      'Chassis SN*', 'Location*', 'Build Engineer*', 'Is Custom Config*',
      'Project Name*', 'System P/N*', 'Platform Type*', 'Manufacturer*', 
      'Chassis Type*', 'BMC Name*', 'BMC MAC*', 'MB SN*', 'Ethernet MAC*',
      'CPU Socket*', 'CPU Vendor*', 'CPU P0 SN*', 'CPU P0 Socket Date Code*',
      'CPU Program Name*', 'M.2 P/N*', 'M.2 SN*', 'DIMM P/N*', 'DIMM Qty*',
      'Visual Inspection Status*', 'Boot Status*', 'DIMMs Detected Status*',
      'LOM Working Status*', 'FPY Status*', 'Status*'
    ];
    
    const headerMap = {};
    headers.forEach((header, index) => {
      headerMap[header] = index;
    });
    
    // Check for missing required headers
    const missingHeaders = requiredHeaders.filter(reqHeader => 
      !headers.some(header => header === reqHeader)
    );
    
    if (missingHeaders.length > 0) {
      throw new Error(`Missing required headers: ${missingHeaders.join(', ')}`);
    }
    
    const results = {
      total: rows.length,
      successful: 0,
      failed: 0,
      errors: [],
      successfulBuilds: []
    };
    
    await connection.beginTransaction();
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNumber = i + 2; // +2 because we skip header and arrays are 0-indexed
      
      try {
        // Extract data from row
        const buildData = {
          chassisSN: row[headerMap['Chassis SN*']],
          jiraTicketNo: row[headerMap['JIRA Ticket No']] || '',
          location: row[headerMap['Location*']],
          buildEngineer: row[headerMap['Build Engineer*']],
          isCustomConfig: row[headerMap['Is Custom Config*']] === 'Yes',
          projectName: row[headerMap['Project Name*']],
          systemPN: row[headerMap['System P/N*']],
          platformType: row[headerMap['Platform Type*']],
          manufacturer: row[headerMap['Manufacturer*']],
          chassisType: row[headerMap['Chassis Type*']],
          bmcName: row[headerMap['BMC Name*']],
          bmcMac: row[headerMap['BMC MAC*']],
          mbSN: row[headerMap['MB SN*']],
          ethernetMac: row[headerMap['Ethernet MAC*']],
          cpuSocket: row[headerMap['CPU Socket*']],
          cpuVendor: row[headerMap['CPU Vendor*']],
          cpuP0SN: row[headerMap['CPU P0 SN*']],
          cpuP0SocketDateCode: row[headerMap['CPU P0 Socket Date Code*']],
          cpuP1SN: row[headerMap['CPU P1 SN']] || '',
          cpuP1SocketDateCode: row[headerMap['CPU P1 Socket Date Code']] || '',
          cpuProgramName: row[headerMap['CPU Program Name*']],
          m2PN: row[headerMap['M.2 P/N*']],
          m2SN: row[headerMap['M.2 SN*']],
          dimmPN: row[headerMap['DIMM P/N*']],
          dimmQty: parseInt(row[headerMap['DIMM Qty*']]) || 0,
          
          // Testing Results
          visualInspectionStatus: row[headerMap['Visual Inspection Status*']],
          visualInspectionNotes: row[headerMap['Visual Inspection Notes']] || '',
          bootStatus: row[headerMap['Boot Status*']],
          bootNotes: row[headerMap['Boot Notes']] || '',
          dimmsDetectedStatus: row[headerMap['DIMMs Detected Status*']],
          dimmsDetectedNotes: row[headerMap['DIMMs Detected Notes']] || '',
          lomWorkingStatus: row[headerMap['LOM Working Status*']],
          lomWorkingNotes: row[headerMap['LOM Working Notes']] || '',
          
          // Quality Details
          fpyStatus: row[headerMap['FPY Status*']],
          problemDescription: row[headerMap['Problem Description']] || '',
          canContinue: row[headerMap['Can Continue']] || '',
          status: row[headerMap['Status*']],
          
          // BKC Details
          biosVersion: row[headerMap['BIOS Version']] || '',
          scmFpgaVersion: row[headerMap['SCM FPGA Version']] || '',
          hpmFpgaVersion: row[headerMap['HPM FPGA Version']] || '',
          bmcVersion: row[headerMap['BMC Version']] || ''
        };
        
        // Validate required fields
        const requiredFields = [
          'chassisSN', 'location', 'buildEngineer', 'projectName', 'systemPN',
          'platformType', 'manufacturer', 'chassisType', 'bmcName', 'bmcMac',
          'mbSN', 'ethernetMac', 'cpuSocket', 'cpuVendor', 'cpuP0SN',
          'cpuP0SocketDateCode', 'cpuProgramName', 'm2PN', 'm2SN', 'dimmPN',
          'visualInspectionStatus', 'bootStatus', 'dimmsDetectedStatus',
          'lomWorkingStatus', 'fpyStatus', 'status'
        ];
        
        for (const field of requiredFields) {
          if (!buildData[field] || buildData[field].toString().trim() === '') {
            throw new Error(`Missing required field: ${field}`);
          }
        }
        
        // Check for duplicate chassis SN
        const [existingBuild] = await connection.execute(
          'SELECT chassis_sn FROM builds WHERE chassis_sn = ?',
          [buildData.chassisSN]
        );
        
        if (existingBuild.length > 0) {
          throw new Error(`Chassis SN already exists: ${buildData.chassisSN}`);
        }
        
        // Handle FPY failure case - save as "continue later" instead of rework
        let finalStatus = buildData.status;
        if (buildData.fpyStatus === 'Fail' && buildData.status === 'Complete') {
          finalStatus = 'In Progress';
          console.log(`Row ${rowNumber}: FPY failed, changing status from Complete to In Progress`);
        }
        
        // Insert build record
        const insertQuery = `
          INSERT INTO builds (
            chassis_sn, jira_ticket_no, location, build_engineer, is_custom_config,
            project_name, system_pn, platform_type, manufacturer, chassis_type,
            bmc_name, bmc_mac, mb_sn, ethernet_mac, cpu_socket, cpu_vendor,
            cpu_p0_sn, cpu_p0_socket_date_code, cpu_p1_sn, cpu_p1_socket_date_code,
            cpu_program_name, m2_pn, m2_sn, dimm_pn, dimm_qty,
            visual_inspection_status, visual_inspection_notes,
            boot_status, boot_notes,
            dimms_detected_status, dimms_detected_notes,
            lom_working_status, lom_working_notes,
            fpy_status, problem_description, can_continue, status,
            bios_version, scm_fpga_version, hpm_fpga_version, bmc_version,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        `;
        
        await connection.execute(insertQuery, [
          buildData.chassisSN, buildData.jiraTicketNo, buildData.location,
          buildData.buildEngineer, buildData.isCustomConfig, buildData.projectName,
          buildData.systemPN, buildData.platformType, buildData.manufacturer,
          buildData.chassisType, buildData.bmcName, buildData.bmcMac,
          buildData.mbSN, buildData.ethernetMac, buildData.cpuSocket,
          buildData.cpuVendor, buildData.cpuP0SN, buildData.cpuP0SocketDateCode,
          buildData.cpuP1SN, buildData.cpuP1SocketDateCode, buildData.cpuProgramName,
          buildData.m2PN, buildData.m2SN, buildData.dimmPN, buildData.dimmQty,
          buildData.visualInspectionStatus, buildData.visualInspectionNotes,
          buildData.bootStatus, buildData.bootNotes,
          buildData.dimmsDetectedStatus, buildData.dimmsDetectedNotes,
          buildData.lomWorkingStatus, buildData.lomWorkingNotes,
          buildData.fpyStatus, buildData.problemDescription, buildData.canContinue,
          finalStatus, buildData.biosVersion, buildData.scmFpgaVersion,
          buildData.hpmFpgaVersion, buildData.bmcVersion
        ]);
        
        // Process DIMM serial numbers
        const dimmSNs = [];
        for (let j = 1; j <= 24; j++) {
          const dimmSN = row[headerMap[`DIMM SN ${j}`]];
          if (dimmSN && dimmSN.toString().trim() !== '') {
            dimmSNs.push(dimmSN.toString().trim());
          }
        }
        
        // Insert DIMM serial numbers
        for (const dimmSN of dimmSNs) {
          await connection.execute(
            'INSERT INTO dimm_serial_numbers (chassis_sn, dimm_sn) VALUES (?, ?)',
            [buildData.chassisSN, dimmSN]
          );
        }
        
        // Process failure modes
        const failureModes = [];
        for (let j = 1; j <= 5; j++) {
          const failureMode = row[headerMap[`Failure Mode ${j}`]];
          if (failureMode && failureMode.toString().trim() !== '') {
            failureModes.push(failureMode.toString().trim());
          }
        }
        
        // Insert failure modes
        for (const failureMode of failureModes) {
          // Get failure category for the mode
          const [categoryResult] = await connection.execute(
            'SELECT failure_category FROM failure_mode_category_map WHERE failure_mode = ?',
            [failureMode]
          );
          
          const failureCategory = categoryResult.length > 0 ? categoryResult[0].failure_category : 'Other';
          
          await connection.execute(
            'INSERT INTO build_failures (chassis_sn, failure_mode, failure_category) VALUES (?, ?, ?)',
            [buildData.chassisSN, failureMode, failureCategory]
          );
        }
        
        results.successful++;
        results.successfulBuilds.push(buildData.chassisSN);
        
        console.log(`Row ${rowNumber}: Successfully processed build ${buildData.chassisSN}`);
        
      } catch (error) {
        console.error(`Row ${rowNumber}: Error processing build:`, error.message);
        results.failed++;
        results.errors.push({
          row: rowNumber,
          chassisSN: row[headerMap['Chassis SN*']] || 'Unknown',
          error: error.message
        });
      }
    }
    
    await connection.commit();
    
    // Clean up uploaded file
    fs.unlinkSync(req.file.path);
    
    console.log('Offline upload processing completed:', results);
    
    res.json({
      success: true,
      message: `Upload completed. ${results.successful} builds processed successfully, ${results.failed} failed.`,
      results: results
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error processing offline upload:', error);
    
    // Clean up uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({
      success: false,
      message: error.message || 'Error processing uploaded file'
    });
    
  } finally {
    connection.release();
  }
});

/**
 * Get upload history/status
 */
router.get('/history', async (req, res) => {
  try {
    const db = getGlobalPool();
    const connection = await db.promise().getConnection();
    
    // Get recent uploads (this would need a separate table to track uploads)
    // For now, just return recent builds with a note about offline uploads
    const [recentBuilds] = await connection.execute(`
      SELECT chassis_sn, location, build_engineer, project_name, status, created_at 
      FROM builds 
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      ORDER BY created_at DESC 
      LIMIT 50
    `);
    
    connection.release();
    
    res.json({
      success: true,
      uploads: recentBuilds
    });
    
  } catch (error) {
    console.error('Error fetching upload history:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching upload history'
    });
  }
});

module.exports = router;