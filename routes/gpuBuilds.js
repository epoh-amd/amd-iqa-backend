const express = require('express');
const router = express.Router();
const { getGlobalPool } = require('../utils/database');

// POST /api/gpu-builds — insert or update a GPU build record
router.post('/gpu-builds', async (req, res) => {
  const {
    gpuSN, cpuSN,
    projectName, po, gpuPN, boardSN, boardManufacturer, asicPN,
    siliconRev, boardRev, gpuRev, modelName,
    cpuPowerRating, heatsinkManufacturer,
    heatsinkPN, heatsinkSN,
    visualInspection, visualInspectionNotes,
    bootToOS, bootToOSNotes,
    gpuDetected, gpuDetectedNotes,
    fAuditEnablement, fAuditEnablementNotes, fAuditValue,
    agfhcLvl3, agfhcLvl3Notes,
    roccRushTest, roccRushTestNotes,
    hbmTest, hbmTestNotes,
    transferBench, transferBenchNotes,
    ifwiVersion, rmVersion,
    status, buildEngineer
  } = req.body;

  if (!gpuSN) {
    return res.status(400).json({ error: 'gpu_sn is required' });
  }

  try {
    const pool = getGlobalPool();

    await pool.promise().query(
      `INSERT INTO gpu_builds (
        gpu_sn, cpu_sn,
        project_name, po, gpu_pn, board_sn, board_manufacturer, asic_pn,
        silicon_rev, board_rev, gpu_rev, model_name,
        cpu_power_rating, heatsink_manufacturer,
        heatsink_pn, heatsink_sn,
        visual_inspection, visual_inspection_notes,
        boot_to_os, boot_to_os_notes,
        gpu_detected, gpu_detected_notes,
        f_audit_enablement, f_audit_enablement_notes, f_audit_value,
        agfhc_lvl3, agfhc_lvl3_notes,
        rocc_rush_test, rocc_rush_test_notes,
        hbm_test, hbm_test_notes,
        transfer_bench, transfer_bench_notes,
        ifwi_version, rm_version, status, build_engineer
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        cpu_sn               = VALUES(cpu_sn),
        project_name         = VALUES(project_name),
        po                   = VALUES(po),
        gpu_pn               = VALUES(gpu_pn),
        board_sn             = VALUES(board_sn),
        board_manufacturer   = VALUES(board_manufacturer),
        asic_pn              = VALUES(asic_pn),
        silicon_rev          = VALUES(silicon_rev),
        board_rev            = VALUES(board_rev),
        gpu_rev              = VALUES(gpu_rev),
        model_name           = VALUES(model_name),
        cpu_power_rating     = VALUES(cpu_power_rating),
        heatsink_manufacturer = VALUES(heatsink_manufacturer),
        heatsink_pn          = VALUES(heatsink_pn),
        heatsink_sn          = VALUES(heatsink_sn),
        visual_inspection       = VALUES(visual_inspection),
        visual_inspection_notes = VALUES(visual_inspection_notes),
        boot_to_os              = VALUES(boot_to_os),
        boot_to_os_notes        = VALUES(boot_to_os_notes),
        gpu_detected            = VALUES(gpu_detected),
        gpu_detected_notes      = VALUES(gpu_detected_notes),
        f_audit_enablement      = VALUES(f_audit_enablement),
        f_audit_enablement_notes = VALUES(f_audit_enablement_notes),
        f_audit_value           = VALUES(f_audit_value),
        agfhc_lvl3              = VALUES(agfhc_lvl3),
        agfhc_lvl3_notes        = VALUES(agfhc_lvl3_notes),
        rocc_rush_test          = VALUES(rocc_rush_test),
        rocc_rush_test_notes    = VALUES(rocc_rush_test_notes),
        hbm_test                = VALUES(hbm_test),
        hbm_test_notes          = VALUES(hbm_test_notes),
        transfer_bench          = VALUES(transfer_bench),
        transfer_bench_notes    = VALUES(transfer_bench_notes),
        ifwi_version         = VALUES(ifwi_version),
        rm_version           = VALUES(rm_version),
        status               = VALUES(status),
        build_engineer       = VALUES(build_engineer),
        updated_at           = CURRENT_TIMESTAMP`,
      [
        gpuSN, cpuSN || null,
        projectName || null, po || null, gpuPN || null, boardSN || null, boardManufacturer || null, asicPN || null,
        siliconRev || null, boardRev || null, gpuRev || null, modelName || null,
        cpuPowerRating || null, heatsinkManufacturer || null,
        heatsinkPN || null, heatsinkSN || null,
        visualInspection || null, visualInspectionNotes || null,
        bootToOS || null, bootToOSNotes || null,
        gpuDetected || null, gpuDetectedNotes || null,
        fAuditEnablement || null, fAuditEnablementNotes || null, fAuditValue || null,
        agfhcLvl3 || null, agfhcLvl3Notes || null,
        roccRushTest || null, roccRushTestNotes || null,
        hbmTest || null, hbmTestNotes || null,
        transferBench || null, transferBenchNotes || null,
        ifwiVersion || null, rmVersion || null,
        status || 'In Progress', buildEngineer || null
      ]
    );

    res.json({ success: true, gpuSN });
  } catch (err) {
    console.error('Error saving GPU build:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'CPU S/N already exists for another GPU build', message: err.message });
    }
    res.status(500).json({ error: 'Failed to save GPU build', message: err.message });
  }
});

// PATCH /api/gpu-builds/:originalGpuSN — update all fields including gpu_sn itself
router.patch('/gpu-builds/:originalGpuSN', async (req, res) => {
  const { originalGpuSN } = req.params;
  const {
    gpuSN, cpuSN,
    projectName, po, gpuPN, boardSN, boardManufacturer, asicPN,
    siliconRev, boardRev, gpuRev, modelName,
    cpuPowerRating, heatsinkManufacturer,
    heatsinkPN, heatsinkSN,
    visualInspection, visualInspectionNotes,
    bootToOS, bootToOSNotes,
    gpuDetected, gpuDetectedNotes,
    fAuditEnablement, fAuditEnablementNotes, fAuditValue,
    agfhcLvl3, agfhcLvl3Notes,
    roccRushTest, roccRushTestNotes,
    hbmTest, hbmTestNotes,
    transferBench, transferBenchNotes,
    ifwiVersion, rmVersion, status
  } = req.body;

  try {
    const pool = getGlobalPool();
    const [result] = await pool.promise().query(
      `UPDATE gpu_builds SET
        gpu_sn = ?, cpu_sn = ?,
        project_name = ?, po = ?, gpu_pn = ?, board_sn = ?, board_manufacturer = ?, asic_pn = ?,
        silicon_rev = ?, board_rev = ?, gpu_rev = ?, model_name = ?,
        cpu_power_rating = ?, heatsink_manufacturer = ?,
        heatsink_pn = ?, heatsink_sn = ?,
        visual_inspection = ?, visual_inspection_notes = ?,
        boot_to_os = ?, boot_to_os_notes = ?,
        gpu_detected = ?, gpu_detected_notes = ?,
        f_audit_enablement = ?, f_audit_enablement_notes = ?, f_audit_value = ?,
        agfhc_lvl3 = ?, agfhc_lvl3_notes = ?,
        rocc_rush_test = ?, rocc_rush_test_notes = ?,
        hbm_test = ?, hbm_test_notes = ?,
        transfer_bench = ?, transfer_bench_notes = ?,
        ifwi_version = ?, rm_version = ?,
        status = ?, build_engineer = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE gpu_sn = ?`,
      [
        gpuSN || originalGpuSN, cpuSN || null,
        projectName || null, po || null, gpuPN || null, boardSN || null, boardManufacturer || null, asicPN || null,
        siliconRev || null, boardRev || null, gpuRev || null, modelName || null,
        cpuPowerRating || null, heatsinkManufacturer || null,
        heatsinkPN || null, heatsinkSN || null,
        visualInspection || null, visualInspectionNotes || null,
        bootToOS || null, bootToOSNotes || null,
        gpuDetected || null, gpuDetectedNotes || null,
        fAuditEnablement || null, fAuditEnablementNotes || null, fAuditValue || null,
        agfhcLvl3 || null, agfhcLvl3Notes || null,
        roccRushTest || null, roccRushTestNotes || null,
        hbmTest || null, hbmTestNotes || null,
        transferBench || null, transferBenchNotes || null,
        ifwiVersion || null, rmVersion || null,
        status !== undefined ? status : (await (async () => { const [r] = await pool.promise().query('SELECT status FROM gpu_builds WHERE gpu_sn = ?', [originalGpuSN]); return r[0]?.status || 'In Progress'; })()),
        buildEngineer || null,
        originalGpuSN
      ]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'GPU build not found' });
    res.json({ success: true, gpuSN: gpuSN || originalGpuSN });
  } catch (err) {
    console.error('[gpu-builds PATCH] Error:', err.message);
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That GPU S/N or CPU S/N already exists', message: err.message });
    res.status(500).json({ error: 'Failed to update GPU build', message: err.message });
  }
});

// GET /api/gpu-builds/search?gpuSN=&cpuSN= — search GPU builds (supports multiple values)
router.get('/gpu-builds/search', async (req, res) => {
  let gpuSNs = req.query.gpuSN ? [].concat(req.query.gpuSN) : [];
  let cpuSNs = req.query.cpuSN ? [].concat(req.query.cpuSN) : [];

  if (gpuSNs.length === 0 && cpuSNs.length === 0) {
    return res.status(400).json({ error: 'Provide at least one gpuSN or cpuSN' });
  }
  try {
    const pool = getGlobalPool();
    const conditions = [];
    const params = [];
    gpuSNs.forEach(s => { conditions.push('gpu_sn LIKE ?'); params.push(`%${s}%`); });
    cpuSNs.forEach(s => { conditions.push('cpu_sn LIKE ?'); params.push(`%${s}%`); });
    const [rows] = await pool.promise().query(
      `SELECT * FROM gpu_builds WHERE ${conditions.join(' OR ')} ORDER BY created_at DESC`,
      params
    );

    // Attach photos to each result
    const results = await Promise.all(rows.map(async (build) => {
      const [photos] = await pool.promise().query(
        'SELECT field_name, file_path FROM gpu_build_photos WHERE gpu_sn = ?', [build.gpu_sn]
      );
      return { ...build, photos };
    }));

    res.json(results);
  } catch (err) {
    console.error('[gpu-builds/search] Error:', err.message);
    res.status(500).json({ error: 'Search failed', message: err.message });
  }
});

// GET /api/gpu-builds/in-progress — list GPU builds with status In Progress (must be before /:gpuSN)
router.get('/gpu-builds/in-progress', async (req, res) => {
  try {
    const pool = getGlobalPool();
    const [rows] = await pool.promise().query(
      `SELECT * FROM gpu_builds WHERE status = 'In Progress' ORDER BY updated_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch in-progress GPU builds', message: err.message });
  }
});

// GET /api/gpu-builds/:gpuSN — fetch a single GPU build with photos
router.get('/gpu-builds/:gpuSN', async (req, res) => {
  const { gpuSN } = req.params;
  try {
    const pool = getGlobalPool();
    const [rows] = await pool.promise().query(
      'SELECT * FROM gpu_builds WHERE gpu_sn = ?', [gpuSN]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const [photos] = await pool.promise().query(
      'SELECT field_name, file_path FROM gpu_build_photos WHERE gpu_sn = ?', [gpuSN]
    );

    res.json({ ...rows[0], photos });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch GPU build', message: err.message });
  }
});

// GET /api/gpu-builds — list all GPU builds
router.get('/gpu-builds', async (req, res) => {
  try {
    const pool = getGlobalPool();
    const [rows] = await pool.promise().query(
      'SELECT * FROM gpu_builds ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch GPU builds', message: err.message });
  }
});

// POST /api/gpu-builds/:gpuSN/photos — save uploaded photo paths
router.post('/gpu-builds/:gpuSN/photos', async (req, res) => {
  const { gpuSN } = req.params;
  const { photos } = req.body; // [{ fieldName, filePath }]
  try {
    const pool = getGlobalPool();
    // Always delete existing photos first (handles removal case when photos is empty)
    await pool.promise().query('DELETE FROM gpu_build_photos WHERE gpu_sn = ?', [gpuSN]);
    if (photos && photos.length > 0) {
      const values = photos.map(p => [gpuSN, p.fieldName, p.filePath]);
      await pool.promise().query(
        'INSERT INTO gpu_build_photos (gpu_sn, field_name, file_path) VALUES ?', [values]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[gpu-builds photos] Error:', err.message);
    res.status(500).json({ error: 'Failed to save photos', message: err.message });
  }
});

// GET /api/gpu-builds/:gpuSN/photos — fetch photos for a GPU build
router.get('/gpu-builds/:gpuSN/photos', async (req, res) => {
  const { gpuSN } = req.params;
  try {
    const pool = getGlobalPool();
    const [rows] = await pool.promise().query(
      'SELECT field_name, file_path FROM gpu_build_photos WHERE gpu_sn = ?', [gpuSN]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch photos', message: err.message });
  }
});

module.exports = router;
