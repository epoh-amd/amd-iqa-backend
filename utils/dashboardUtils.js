// backend/utils/dashboardUtils.js
/**
 * Backend utility functions for dashboard configuration
 * These functions should match the frontend implementation exactly
 */

/**
 * Generate weekly dates between start and end date
 * FIXED: Now matches the frontend generateWeeklyDates implementation exactly
 * 
 * @param {string} startDate - Start date in YYYY-MM-DD format
 * @param {string} endDate - End date in YYYY-MM-DD format
 * @returns {Array} - Array of weekly date objects matching frontend format
 */
const generateWeeklyDates = (startDate, endDate) => {
  if (!startDate || !endDate) return [];
  
  const weeks = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  let current = new Date(start);
  while (current <= end) {
    const weekStart = new Date(current);
    weeks.push({
      week: `${(weekStart.getMonth() + 1).toString().padStart(2, '0')}/${weekStart.getDate().toString().padStart(2, '0')}`,
      date: weekStart.toISOString().split('T')[0],
      porTarget: 0
    });
    current.setDate(current.getDate() + 7);
  }
  
  return weeks;
};

/**
 * Auto-calculate milestone dates based on start/end dates (not duration)
 * CORRECTED: Milestones are defined by start/end dates directly
 * 
 * @param {string} startDate - Project start date
 * @param {string} endDate - Project end date
 * @param {Array} milestones - Array of milestone objects with startDate/endDate
 * @returns {Array} - Milestones with validated dates
 */
const autoCalculateMilestoneDates = (startDate, endDate, milestones) => {
  if (!startDate || !endDate || !milestones || milestones.length === 0) return [];
  
  // If milestones don't have dates, distribute them evenly
  if (milestones.some(m => !m.startDate || !m.endDate)) {
    const projectStart = new Date(startDate);
    const projectEnd = new Date(endDate);
    const projectDurationDays = (projectEnd - projectStart) / (1000 * 60 * 60 * 24);
    const daysPerMilestone = Math.floor(projectDurationDays / milestones.length);
    
    return milestones.map((milestone, index) => {
      const milestoneStart = new Date(projectStart);
      milestoneStart.setDate(milestoneStart.getDate() + (index * daysPerMilestone));
      
      const milestoneEnd = new Date(milestoneStart);
      if (index === milestones.length - 1) {
        // Last milestone ends with project
        milestoneEnd.setTime(projectEnd.getTime());
      } else {
        milestoneEnd.setDate(milestoneEnd.getDate() + daysPerMilestone - 1);
      }
      
      return {
        ...milestone,
        startDate: milestoneStart.toISOString().split('T')[0],
        endDate: milestoneEnd.toISOString().split('T')[0],
        porTarget: milestone.porTarget || 0
      };
    });
  }
  
  // If milestones already have dates, just validate and return them
  return milestones.map(milestone => ({
    ...milestone,
    startDate: milestone.startDate,
    endDate: milestone.endDate,
    porTarget: milestone.porTarget || 0
  }));
};

/**
 * Ensure porTargets array is properly sized to match the number of weeks
 * FIXED: Now matches the frontend ensurePorTargetsSize implementation exactly
 * 
 * @param {Array} currentPorTargets - Current porTargets array (may be undefined or wrong size)
 * @param {string} startDate - Start date for the project
 * @param {string} endDate - End date for the project
 * @returns {Array} - Properly sized porTargets array
 */
const ensurePorTargetsSize = (currentPorTargets, startDate, endDate) => {
  if (!startDate || !endDate) return currentPorTargets || [];
  
  const weeks = generateWeeklyDates(startDate, endDate);
  const existingTargets = currentPorTargets || [];
  
  // Create new array with correct size, preserving existing values
  return Array(weeks.length).fill(0).map((_, idx) => existingTargets[idx] || 0);
};

/**
 * Validate configuration data before saving
 * Matches frontend validation logic
 * 
 * @param {Object} configData - Configuration data to validate
 * @returns {Object} - Validation result with isValid and errors
 */
const validateConfiguration = (configData) => {
  const errors = [];
  
  if (!configData.startDate) {
    errors.push('Start date is required');
  }
  
  if (!configData.endDate) {
    errors.push('End date is required');
  }
  
  if (configData.startDate && configData.endDate) {
    const start = new Date(configData.startDate);
    const end = new Date(configData.endDate);
    if (start >= end) {
      errors.push('End date must be after start date');
    }
  }
  
  if (!configData.milestones || configData.milestones.length === 0) {
    errors.push('At least one milestone is required');
  } else {
    configData.milestones.forEach((milestone, index) => {
      if (!milestone.name) {
        errors.push(`Milestone ${index + 1} name is required`);
      }
    });
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
};

/**
 * Convert frontend porTargets array to backend porTargetsByWeek object
 * 
 * @param {Array} porTargets - Array of POR targets by week index
 * @param {string} startDate - Project start date
 * @param {string} endDate - Project end date
 * @returns {Object} - Object with week dates as keys and quantities as values
 */
/*
const convertPorTargetsToWeeklyObject = (porTargets, startDate, endDate) => {
  if (!porTargets || !startDate || !endDate) return {};
  
  const weeks = generateWeeklyDates(startDate, endDate);
  const porTargetsByWeek = {};
  
  weeks.forEach((week, index) => {
    const quantity = porTargets[index];
    // Save all values, including zeros, to preserve user input
    porTargetsByWeek[week.date] = parseInt(quantity) || 0;
  });
  
  return porTargetsByWeek;
};
*/
const convertPorTargetsToWeeklyObject = (
  smartTargets,
  nonSmartTargets,
  porTargets,
  startDate,
  endDate
) => {
  if (!startDate || !endDate) return {};

  const weeks = generateWeeklyDates(startDate, endDate);

  const result = {};

  weeks.forEach((week, index) => {
    const smart = parseInt(smartTargets?.[index]) || 0;
    const nonSmart = parseInt(nonSmartTargets?.[index]) || 0;
    const total = parseInt(porTargets?.[index]) || (smart + nonSmart);

    result[week.date] = {
      smart,
      nonSmart,
      por: total
    };
  });

  return result;
};

/**
 * Convert backend porTargetsByWeek object to frontend porTargets array
 * 
 * @param {Object} porTargetsByWeek - Object with week dates as keys
 * @param {string} startDate - Project start date
 * @param {string} endDate - Project end date
 * @returns {Array} - Array of POR targets by week index
 */
const convertWeeklyObjectToPorTargets = (porTargetsByWeek, startDate, endDate) => {
  if (!porTargetsByWeek || !startDate || !endDate) return [];
  
  const weeks = generateWeeklyDates(startDate, endDate);
  return weeks.map(week => porTargetsByWeek[week.date] || 0);
};

module.exports = {
  generateWeeklyDates,
  autoCalculateMilestoneDates,
  ensurePorTargetsSize,
  validateConfiguration,
  convertPorTargetsToWeeklyObject,
  convertWeeklyObjectToPorTargets
};