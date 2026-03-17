// backend/firmwareExtractor.js
const puppeteer = require('puppeteer');

async function extractBMCFirmwareVersions(bmcName) {
  let browser;
  try {
    // Format the BMC name to lowercase
    const formattedBmcName = bmcName.toLowerCase();
    const url = `https://${formattedBmcName}/`;
    
    console.log(`Starting firmware extraction for BMC: ${bmcName}`);
    
    // Launch a new browser with additional arguments to bypass certificate errors
    browser = await puppeteer.launch({
      headless: true, // Run in headless mode for server
      ignoreHTTPSErrors: true,
      args: [
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list',
        '--disable-web-security',
        '--allow-running-insecure-content',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-plugins',
        '--disable-images',
        '--disable-javascript',
        '--disable-default-apps'
      ]
    });
    
    const page = await browser.newPage();
    
    // Set a reasonable viewport
    await page.setViewport({ width: 1280, height: 800 });
    
    // Set user agent to avoid detection
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    
    // Navigate to the BMC login page
    console.log(`Navigating to ${url}`);
    await page.goto(url, { 
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    
    console.log('Waiting for login form...');
    
    // Wait for login form - try multiple selectors
    const loginSelector = await page.waitForSelector([
      'input[type="text"]',
      'input[id="username"]', 
      'input[name="username"]',
      'input[placeholder*="username" i]',
      'input[placeholder*="user" i]'
    ].join(','), { 
      timeout: 30000,
      visible: true 
    }).catch(() => null);
    
    if (!loginSelector) {
      throw new Error('Login form not found on the page');
    }
    
    // Find the username and password fields
    const usernameSelector = await page.$([
      'input[type="text"]',
      'input[id="username"]',
      'input[name="username"]',
      'input[placeholder*="username" i]'
    ].join(','));
    
    const passwordSelector = await page.$([
      'input[type="password"]',
      'input[id="password"]',
      'input[name="password"]',
      'input[placeholder*="password" i]'
    ].join(','));
    
    if (!usernameSelector || !passwordSelector) {
      throw new Error('Username or password field not found');
    }
    
    // Clear fields first and enter credentials
    await usernameSelector.click({ clickCount: 3 });
    await usernameSelector.type('root', { delay: 100 });
    
    await passwordSelector.click({ clickCount: 3 });
    await passwordSelector.type('0penBmc', { delay: 100 });
    
    console.log('Entering credentials...');
    
    // Find and click the login button
    // Only use valid CSS selectors (no :has-text)
    const loginButton = await page.$([
      'button[type="submit"]',
      'input[type="submit"]',
      '.login-btn',
      '#login-btn'
    ].join(','));
    
    if (loginButton) {
      await Promise.all([
        page.waitForNavigation({ 
          waitUntil: 'domcontentloaded', 
          timeout: 30000 
        }).catch(() => console.log('Navigation timeout, continuing...')),
        loginButton.click()
      ]);
    } else {
      // Try pressing Enter as an alternative
      await Promise.all([
        page.waitForNavigation({ 
          waitUntil: 'domcontentloaded', 
          timeout: 30000 
        }).catch(() => console.log('Navigation timeout, continuing...')),
        page.keyboard.press('Enter')
      ]);
    }
    
    console.log('Login attempt completed');
    
    // Wait a bit for the page to stabilize
    await page.waitForTimeout(5000);
    
    // Try multiple firmware page URLs
    const firmwareUrls = [
      `https://${formattedBmcName}/#/operations/firmware`,
      `https://${formattedBmcName}/redfish/v1/UpdateService/FirmwareInventory`,
      `https://${formattedBmcName}/xyz/openbmc_project/software`,
      `https://${formattedBmcName}/#/server-control/firmware`,
      `https://${formattedBmcName}/firmware`,
      `https://${formattedBmcName}/gui/firmware.html`
    ];
    
    let firmwarePageLoaded = false;
    let firmwareHtml = null;
    for (const firmwareUrl of firmwareUrls) {
      try {
        console.log(`Trying firmware URL: ${firmwareUrl}`);
        await page.goto(firmwareUrl, { 
          waitUntil: 'domcontentloaded',
          timeout: 20000 
        });
        // Wait for firmware content to load
        await page.waitForTimeout(3000);
        // Check if we have firmware-related content
        const hasFirmwareContent = await page.evaluate(() => {
          const text = document.body.textContent.toLowerCase();
          return text.includes('firmware') || 
                 text.includes('version') || 
                 text.includes('bios') || 
                 text.includes('bmc') ||
                 text.includes('fpga');
        });
        if (hasFirmwareContent) {
          firmwareHtml = await page.content();
          console.log(`Found firmware content at: ${firmwareUrl}`);
          firmwarePageLoaded = true;
          break;
        }
      } catch (error) {
        console.log(`Failed to load ${firmwareUrl}: ${error.message}`);
        continue;
      }
    }
    
    if (!firmwarePageLoaded) {
      throw new Error('Could not access firmware information page');
    }

    // Save the HTML for debugging
    const fs = require('fs');
    const path = require('path');
    const htmlPath = path.join(__dirname, `firmware-page-${bmcName}.html`);
    try {
      fs.writeFileSync(htmlPath, firmwareHtml || '', 'utf8');
      console.log(`Firmware page HTML saved to: ${htmlPath}`);
    } catch (e) {
      console.warn('Failed to save firmware page HTML:', e.message);
    }
    
    console.log('Firmware page loaded, extracting versions...');
    
    // Try to extract firmware versions with improved selectors
    const versions = await page.evaluate(() => {
      const versionData = {};
      // Helper function to clean version strings
      const cleanVersion = (version) => {
        if (!version) return null;
        return version.replace(/[^\w\.-]/g, '').trim();
      };

      // Extract BMC version
      const bmcSection = Array.from(document.querySelectorAll('h2')).find(h => h.textContent.trim().toLowerCase() === 'bmc');
      if (bmcSection) {
        const bmcCard = bmcSection.parentElement.querySelector('.card-deck .card');
        if (bmcCard) {
          const bmcVersion = bmcCard.querySelector('dt')?.textContent.trim().toLowerCase() === 'version'
            ? bmcCard.querySelector('dd')?.textContent.trim() : null;
          if (bmcVersion && bmcVersion !== '--') versionData.bmcVersion = cleanVersion(bmcVersion);
        }
      }

      // Extract Host version
      const hostSection = Array.from(document.querySelectorAll('h2')).find(h => h.textContent.trim().toLowerCase() === 'host');
      if (hostSection) {
        const hostCard = hostSection.parentElement.querySelector('.card-deck .card');
        if (hostCard) {
          const hostVersion = hostCard.querySelector('dt')?.textContent.trim().toLowerCase() === 'version'
            ? hostCard.querySelector('dd')?.textContent.trim() : null;
          if (hostVersion && hostVersion !== '--') versionData.hostVersion = cleanVersion(hostVersion);
        }
      }

      // Extract HPM_FPGA version
      const hpmSection = Array.from(document.querySelectorAll('h2')).find(h => h.textContent.trim().toLowerCase() === 'hpm_fpga');
      if (hpmSection) {
        const hpmCard = hpmSection.parentElement.querySelector('.card-deck .card');
        if (hpmCard) {
          const hpmVersion = hpmCard.querySelector('dt')?.textContent.trim().toLowerCase() === 'version'
            ? hpmCard.querySelector('dd')?.textContent.trim() : null;
          if (hpmVersion && hpmVersion !== '--') versionData.hpmFpgaVersion = cleanVersion(hpmVersion);
        }
      }

      return versionData;
    });
    
    console.log('Extracted firmware versions:', versions);
    
    // Validate that we got at least some versions
    const hasRequiredVersions = versions.hostVersion && versions.bmcVersion && versions.hpmFpgaVersion;
    const hasAnyVersion = Object.values(versions).some(v => v !== null && v !== undefined);
    
    if (!hasAnyVersion) {
      throw new Error('No firmware versions could be extracted from the page');
    }
    
    if (!hasRequiredVersions) {
      console.warn('Some required firmware versions are missing:', {
        hostVersion: !!versions.hostVersion,
        bmcVersion: !!versions.bmcVersion,
        hpmFpgaVersion: !!versions.hpmFpgaVersion,
        scmFpgaVersion: !!versions.scmFpgaVersion
      });
    }
    
    // Return versions, ensuring SCM FPGA is optional
    return {
      hostVersion: versions.hostVersion || null,
      bmcVersion: versions.bmcVersion || null,
      hpmFpgaVersion: versions.hpmFpgaVersion || null,
      scmFpgaVersion: versions.scmFpgaVersion || null // Optional - can be null
    };
    
  } catch (error) {
    console.error('Error extracting firmware versions:', error);
    
    // Provide more specific error messages
    if (error.message.includes('net::ERR_NAME_NOT_RESOLVED')) {
      throw new Error(`Cannot resolve BMC hostname: ${bmcName}. Please check if the BMC is accessible.`);
    } else if (error.message.includes('net::ERR_CONNECTION_REFUSED')) {
      throw new Error(`Connection refused to BMC: ${bmcName}. Please check if the BMC is online.`);
    } else if (error.message.includes('net::ERR_TIMED_OUT')) {
      throw new Error(`Connection timeout to BMC: ${bmcName}. The BMC may be slow to respond.`);
    } else if (error.message.includes('Login form not found')) {
      throw new Error(`BMC login page not accessible: ${bmcName}. Please check BMC web interface.`);
    } else if (error.message.includes('Could not access firmware')) {
      throw new Error(`BMC firmware page not accessible: ${bmcName}. Please check BMC permissions.`);
    } else {
      throw new Error(`Failed to extract firmware versions: ${error.message}`);
    }
  } finally {
    // Always close the browser
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = { extractBMCFirmwareVersions };