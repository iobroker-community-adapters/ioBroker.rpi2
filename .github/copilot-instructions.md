# ioBroker Adapter Development with GitHub Copilot

**Version:** 0.5.7  
**Template Source:** https://github.com/DrozmotiX/ioBroker-Copilot-Instructions

This file contains instructions and best practices for GitHub Copilot when working on ioBroker adapter development.

---

## 📑 Table of Contents

1. [Project Context](#project-context)
2. [Code Quality & Standards](#code-quality--standards)
   - [Code Style Guidelines](#code-style-guidelines)
   - [ESLint Configuration](#eslint-configuration)
3. [Testing](#testing)
   - [Unit Testing](#unit-testing)
   - [Integration Testing](#integration-testing)
   - [API Testing with Credentials](#api-testing-with-credentials)
4. [Development Best Practices](#development-best-practices)
   - [Dependency Management](#dependency-management)
   - [HTTP Client Libraries](#http-client-libraries)
   - [Error Handling](#error-handling)
5. [Admin UI Configuration](#admin-ui-configuration)
   - [JSON-Config Setup](#json-config-setup)
   - [Translation Management](#translation-management)
6. [Hardware Integration Patterns for RPI2](#hardware-integration-patterns-for-rpi2)
7. [Hardware-Specific Development Guidelines](#hardware-specific-development-guidelines)
8. [Deployment and Dependencies](#deployment-and-dependencies)
9. [Documentation](#documentation)
   - [README Updates](#readme-updates)
   - [Changelog Management](#changelog-management)
10. [CI/CD & GitHub Actions](#cicd--github-actions)
    - [Workflow Configuration](#workflow-configuration)
    - [Testing Integration](#testing-integration)

---

## Project Context

You are working on an ioBroker adapter. ioBroker is an integration platform for the Internet of Things, focused on building smart home and industrial IoT solutions. Adapters are plugins that connect ioBroker to external systems, devices, or services.

### RPI2 Adapter Specific Context

This is the **ioBroker.rpi2** adapter for monitoring Raspberry Pi systems and controlling GPIO pins. Key characteristics:

- **Primary Function**: Raspberry Pi system monitoring (CPU, memory, temperature, network, storage) with GPIO control capabilities
- **Hardware Integration**: Direct GPIO access using opengpio library, DHT sensor support (DHT11/DHT22), NVMe temperature monitoring
- **Platform Requirements**: Linux only (specifically optimized for Raspberry Pi), requires libgpiod-dev system library
- **Key Features**:
  - System monitoring (CPU, RAM, disk usage, temperature, network statistics)
  - GPIO input/output control with configurable pull-up/down resistors
  - DHT temperature and humidity sensors (DHT11, DHT22, AM23xx)
  - NVMe SSD temperature monitoring (requires nvme-cli and sudo configuration)
  - Multiple adapter instances per host (since v2.4.0)
- **Native Dependencies**: opengpio (GPIO control), node-dht-sensor (temperature sensors)
- **Configuration**: JSON-based GPIO configuration with per-pin settings for direction, debounce, pull resistors

---

## Code Quality & Standards

### Code Style Guidelines

- Follow JavaScript/TypeScript best practices
- Use async/await for asynchronous operations
- Implement proper resource cleanup in `unload()` method
- Use semantic versioning for adapter releases
- Include proper JSDoc comments for public methods

**Timer and Resource Cleanup Example:**
```javascript
private connectionTimer?: NodeJS.Timeout;

async onReady() {
  this.connectionTimer = setInterval(() => this.checkConnection(), 30000);
}

onUnload(callback) {
  try {
    if (this.connectionTimer) {
      clearInterval(this.connectionTimer);
      this.connectionTimer = undefined;
    }
    callback();
  } catch (e) {
    callback();
  }
}
```

### ESLint Configuration

**CRITICAL:** ESLint validation must run FIRST in your CI/CD pipeline, before any other tests. This "lint-first" approach catches code quality issues early.

#### Setup
```bash
npm install --save-dev eslint @iobroker/eslint-config
```

#### Configuration (.eslintrc.json)
```json
{
  "extends": "@iobroker/eslint-config",
  "rules": {
    // Add project-specific rule overrides here if needed
  }
}
```

#### Package.json Scripts
```json
{
  "scripts": {
    "lint": "eslint --max-warnings 0 .",
    "lint:fix": "eslint . --fix"
  }
}
```

#### Best Practices
1. ✅ Run ESLint before committing — fix ALL warnings, not just errors
2. ✅ Use `lint:fix` for auto-fixable issues
3. ✅ Don't disable rules without documentation
4. ✅ Lint all relevant files (main code, tests, build scripts)
5. ✅ Keep `@iobroker/eslint-config` up to date
6. ✅ **ESLint warnings are treated as errors in CI** (`--max-warnings 0`). The `lint` script above already includes this flag — run `npm run lint` to match CI behavior locally

#### Common Issues
- **Unused variables**: Remove or prefix with underscore (`_variable`)
- **Missing semicolons**: Run `npm run lint:fix`
- **Indentation**: Use 4 spaces (ioBroker standard)
- **console.log**: Replace with `adapter.log.debug()` or remove

---

## Testing

### Unit Testing

- Use Jest as the primary testing framework
- Create tests for all adapter main functions and helper methods
- Test error handling scenarios and edge cases
- Mock external API calls and hardware dependencies
- For adapters connecting to APIs/devices not reachable by internet, provide example data files

**Example Structure:**
```javascript
describe('AdapterName', () => {
  let adapter;
  
  beforeEach(() => {
    // Setup test adapter instance
  });
  
  test('should initialize correctly', () => {
    // Test adapter initialization
  });
});
```

### Integration Testing

**CRITICAL:** Use the official `@iobroker/testing` framework. This is the ONLY correct way to test ioBroker adapters.

**Official Documentation:** https://github.com/ioBroker/testing

#### Framework Structure

**✅ Correct Pattern:**
```javascript
const path = require('path');
const { tests } = require('@iobroker/testing');

tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Test adapter with specific configuration', (getHarness) => {
            let harness;

            before(() => {
                harness = getHarness();
            });

            it('should configure and start adapter', function () {
                return new Promise(async (resolve, reject) => {
                    try {
                        // Get adapter object
                        const obj = await new Promise((res, rej) => {
                            harness.objects.getObject('system.adapter.your-adapter.0', (err, o) => {
                                if (err) return rej(err);
                                res(o);
                            });
                        });
                        
                        if (!obj) return reject(new Error('Adapter object not found'));

                        // Configure adapter
                        Object.assign(obj.native, {
                            position: '52.520008,13.404954',
                            createHourly: true,
                        });

                        harness.objects.setObject(obj._id, obj);
                        
                        // Start and wait
                        await harness.startAdapterAndWait();
                        await new Promise(resolve => setTimeout(resolve, 15000));

                        // Verify states
                        const stateIds = await harness.dbConnection.getStateIDs('your-adapter.0.*');
                        
                        if (stateIds.length > 0) {
                            console.log('✅ Adapter successfully created states');
                            await harness.stopAdapter();
                            resolve(true);
                        } else {
                            reject(new Error('Adapter did not create any states'));
                        }
                    } catch (error) {
                        reject(error);
                    }
                });
            }).timeout(40000);
        });
    }
});
```

#### Testing Success AND Failure Scenarios

**IMPORTANT:** For every "it works" test, implement corresponding "it fails gracefully" tests.

**Failure Scenario Example:**
```javascript
it('should NOT create daily states when daily is disabled', function () {
    return new Promise(async (resolve, reject) => {
        try {
            harness = getHarness();
            const obj = await new Promise((res, rej) => {
                harness.objects.getObject('system.adapter.your-adapter.0', (err, o) => {
                    if (err) return rej(err);
                    res(o);
                });
            });
            
            if (!obj) return reject(new Error('Adapter object not found'));

            Object.assign(obj.native, {
                createDaily: false, // Daily disabled
            });

            await new Promise((res, rej) => {
                harness.objects.setObject(obj._id, obj, (err) => {
                    if (err) return rej(err);
                    res(undefined);
                });
            });

            await harness.startAdapterAndWait();
            await new Promise((res) => setTimeout(res, 20000));

            const stateIds = await harness.dbConnection.getStateIDs('your-adapter.0.*');
            const dailyStates = stateIds.filter((key) => key.includes('daily'));
            
            if (dailyStates.length === 0) {
                console.log('✅ No daily states found as expected');
                resolve(true);
            } else {
                reject(new Error('Expected no daily states but found some'));
            }

            await harness.stopAdapter();
        } catch (error) {
            reject(error);
        }
    });
}).timeout(40000);
```

#### Advanced State Access Patterns

For testing adapters that create multiple states, use bulk state access methods to efficiently verify large numbers of states:

```javascript
it('should create and verify multiple states', () => new Promise(async (resolve, reject) => {
    harness.objects.getObject('system.adapter.rpi2.0', async (err, obj) => {
        if (err) {
            console.error('Error getting adapter object:', err);
            reject(err);
            return;
        }

        obj.native.someConfig = 'test-value';
        harness.objects.setObject(obj._id, obj);

        await harness.startAdapterAndWait();

        setTimeout(() => {
            harness.dbConnection.getStateIDs('rpi2.0.*').then(stateIds => {
                if (stateIds && stateIds.length > 0) {
                    harness.states.getStates(stateIds, (err, allStates) => {
                        if (err) {
                            console.error('❌ Error getting states:', err);
                            reject(err);
                            return;
                        }

                        const expectedStates = ['rpi2.0.info.connection'];
                        let foundStates = 0;
                        
                        for (const stateId of expectedStates) {
                            if (allStates[stateId]) {
                                foundStates++;
                                console.log(`✅ Found expected state: ${stateId}`);
                            } else {
                                console.log(`❌ Missing expected state: ${stateId}`);
                            }
                        }

                        if (foundStates === expectedStates.length) {
                            console.log('✅ All expected states were created successfully');
                            resolve();
                        } else {
                            reject(new Error(`Only ${foundStates}/${expectedStates.length} expected states were found`));
                        }
                    });
                } else {
                    reject(new Error('No states found matching pattern rpi2.0.*'));
                }
            }).catch(reject);
        }, 20000);
    });
})).timeout(45000);
```

#### Hardware-Specific Testing for RPI2 Adapter

When testing the RPI2 adapter, special considerations apply due to hardware dependencies:

```javascript
// Mock GPIO operations when hardware is not available
const mockGpioControl = {
    setup: jest.fn(),
    read: jest.fn(() => 0),
    write: jest.fn(),
    cleanup: jest.fn()
};

// Mock DHT sensor readings
const mockDHTSensor = {
    read: jest.fn(() => ({ temperature: 22.5, humidity: 45.2 })),
    initialize: jest.fn(() => ({ sensor_type: 22, pin: 4 }))
};

// Example integration test for GPIO configuration
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Test RPI2 adapter GPIO configuration', (getHarness) => {
            it('should handle GPIO configuration without hardware', async function() {
                const harness = getHarness();
                
                // Configure GPIO settings
                const obj = await harness.objects.getObjectAsync('system.adapter.rpi2.0');
                Object.assign(obj.native, {
                    gpioSettings: [
                        { gpio: 18, configuration: 'out', label: 'Test LED' },
                        { gpio: 4, configuration: 'dht22', label: 'Temperature Sensor' }
                    ]
                });
                
                await harness.objects.setObjectAsync(obj._id, obj);
                await harness.startAdapterAndWait();
                
                // Verify GPIO objects were created
                const gpioObjects = await harness.objects.getObjectViewAsync('system', 'state', {
                    startkey: 'rpi2.0.gpio.',
                    endkey: 'rpi2.0.gpio.\u9999'
                });
                
                expect(gpioObjects.rows.length).toBeGreaterThan(0);
            });
        });
    }
});
```

#### Key Rules

1. ✅ Use `@iobroker/testing` framework
2. ✅ Configure via `harness.objects.setObject()`
3. ✅ Start via `harness.startAdapterAndWait()`
4. ✅ Verify states via `harness.states.getState()`
5. ✅ Allow proper timeouts for async operations
6. ❌ NEVER test API URLs directly
7. ❌ NEVER bypass the harness system

#### Workflow Dependencies

Integration tests should run ONLY after lint and adapter tests pass:

```yaml
integration-tests:
  needs: [check-and-lint, adapter-tests]
  runs-on: ubuntu-22.04
```

### API Testing with Credentials

For adapters connecting to external APIs requiring authentication:

#### Password Encryption for Integration Tests

```javascript
async function encryptPassword(harness, password) {
    const systemConfig = await harness.objects.getObjectAsync("system.config");
    if (!systemConfig?.native?.secret) {
        throw new Error("Could not retrieve system secret for password encryption");
    }
    
    const secret = systemConfig.native.secret;
    let result = '';
    for (let i = 0; i < password.length; ++i) {
        result += String.fromCharCode(secret[i % secret.length].charCodeAt(0) ^ password.charCodeAt(i));
    }
    return result;
}
```

#### Demo Credentials Testing Pattern

- Use provider demo credentials when available (e.g., `demo@api-provider.com` / `demo`)
- Create separate test file: `test/integration-demo.js`
- Add npm script: `"test:integration-demo": "mocha test/integration-demo --exit"`
- Implement clear success/failure criteria

**Example Implementation:**
```javascript
it("Should connect to API with demo credentials", async () => {
    const encryptedPassword = await encryptPassword(harness, "demo_password");
    
    await harness.changeAdapterConfig("your-adapter", {
        native: {
            username: "demo@provider.com",
            password: encryptedPassword,
        }
    });

    await harness.startAdapter();
    await new Promise(resolve => setTimeout(resolve, 60000));
    
    const connectionState = await harness.states.getStateAsync("your-adapter.0.info.connection");
    
    if (connectionState?.val === true) {
        console.log("✅ SUCCESS: API connection established");
        return true;
    } else {
        throw new Error("API Test Failed: Expected API connection. Check logs for API errors.");
    }
}).timeout(120000);
```

---

## Development Best Practices

### Dependency Management

- Always use `npm` for dependency management
- Use `npm ci` for installing existing dependencies (respects package-lock.json)
- Use `npm install` only when adding or updating dependencies
- Keep dependencies minimal and focused
- Only update dependencies in separate Pull Requests

**When modifying package.json:**
1. Run `npm install` to sync package-lock.json
2. Commit both package.json and package-lock.json together

**Best Practices:**
- Prefer built-in Node.js modules when possible
- Use `@iobroker/adapter-core` for adapter base functionality
- Avoid deprecated packages
- Document specific version requirements

### HTTP Client Libraries

- **Preferred:** Use native `fetch` API (Node.js 20+ required)
- **Avoid:** `axios` unless specific features are required

**Example with fetch:**
```javascript
try {
  const response = await fetch('https://api.example.com/data');
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  const data = await response.json();
} catch (error) {
  this.log.error(`API request failed: ${error.message}`);
}
```

**Other Recommendations:**
- **Logging:** Use adapter built-in logging (`this.log.*`)
- **Scheduling:** Use adapter built-in timers and intervals
- **File operations:** Use Node.js `fs/promises`
- **Configuration:** Use adapter config system

### Error Handling

- Always catch and log errors appropriately
- Use adapter log levels (error, warn, info, debug)
- Provide meaningful, user-friendly error messages
- Handle network failures gracefully
- Implement retry mechanisms where appropriate
- Always clean up timers, intervals, and resources in `unload()` method

**Example:**
```javascript
try {
  await this.connectToDevice();
} catch (error) {
  this.log.error(`Failed to connect to device: ${error.message}`);
  this.setState('info.connection', false, true);
  // Implement retry logic if needed
}
```

---

## Admin UI Configuration

### JSON-Config Setup

Use JSON-Config format for modern ioBroker admin interfaces.

**Example Structure:**
```json
{
  "type": "panel",
  "items": {
    "host": {
      "type": "text",
      "label": "Host address",
      "help": "IP address or hostname of the device"
    }
  }
}
```

**Guidelines:**
- ✅ Use consistent naming conventions
- ✅ Provide sensible default values
- ✅ Include validation for required fields
- ✅ Add tooltips for complex options
- ✅ Ensure translations for all supported languages (minimum English and German)
- ✅ Write end-user friendly labels, avoid technical jargon

#### JSON Config Structure for Hardware Adapters

The RPI2 adapter uses JSONConfig for its admin interface. Follow these patterns:

```json
{
    "gpioSettings": {
        "type": "table",
        "items": {
            "gpio": {
                "type": "number",
                "min": 2,
                "max": 40
            },
            "configuration": {
                "type": "select",
                "options": ["in", "out", "outlow", "outhigh", "dht11", "dht22"]
            },
            "label": {
                "type": "text"
            },
            "debounceOrPoll": {
                "type": "number",
                "min": 0
            }
        }
    }
}
```

#### Configuration Validation

```javascript
// Validate GPIO configuration
validateGpioConfig(config) {
    const errors = [];
    const usedPins = new Set();
    
    for (const gpio of config.gpioSettings || []) {
        if (usedPins.has(gpio.gpio)) {
            errors.push(`GPIO ${gpio.gpio} is configured multiple times`);
        }
        usedPins.add(gpio.gpio);
        
        if (gpio.gpio < 2 || gpio.gpio > 40) {
            errors.push(`GPIO ${gpio.gpio} is out of valid range (2-40)`);
        }
    }
    
    return errors;
}
```

### Translation Management

**CRITICAL:** Translation files must stay synchronized with `admin/jsonConfig.json`. Orphaned keys or missing translations cause UI issues and PR review delays.

#### Overview
- **Location:** `admin/i18n/{lang}/translations.json` for 11 languages (de, en, es, fr, it, nl, pl, pt, ru, uk, zh-cn)
- **Source of truth:** `admin/jsonConfig.json` - all `label` and `help` properties must have translations
- **Command:** `npm run translate` - auto-generates translations but does NOT remove orphaned keys
- **Formatting:** English uses tabs, other languages use 4 spaces

#### Critical Rules
1. ✅ Keys must match exactly with jsonConfig.json
2. ✅ No orphaned keys in translation files
3. ✅ All translations must be in native language (no English fallbacks)
4. ✅ Keys must be sorted alphabetically

#### Workflow for Translation Updates

**When modifying admin/jsonConfig.json:**

1. Make your changes to labels/help texts
2. Run automatic translation: `npm run translate`
3. Run validation to check for missing or orphaned keys
4. Remove orphaned keys manually from all translation files
5. Add missing translations in native languages
6. Run: `npm run lint && npm run test`

#### Translation Checklist

Before committing changes to admin UI or translations:
1. ✅ No orphaned keys in any translation file
2. ✅ All translations in native language
3. ✅ Keys alphabetically sorted
4. ✅ `npm run lint` passes
5. ✅ `npm run test` passes

---

## Hardware Integration Patterns for RPI2

The RPI2 adapter has specific patterns for hardware integration:

### GPIO Control Pattern
```javascript
// GPIO configuration structure
const gpioConfig = {
    gpio: 18,                    // Pin number (BCM numbering)
    configuration: 'out',        // 'in', 'out', 'outlow', 'outhigh', 'button', 'dht11', 'dht22'
    label: 'LED Control',        // Human-readable name
    debounceOrPoll: 100,        // Debounce time for inputs or poll interval for DHT
    pullUp: false,              // Internal pull-up resistor for inputs
    invert: false               // Invert true/false to 1/0 mapping
};

// Initialize GPIO in adapter
this.gpioControl = new GpioControl(this, this.log);
await this.syncPort(gpioConfig);
```

### DHT Sensor Integration Pattern
```javascript
// DHT sensor reading with error handling
async readDHTSensor(gpio, sensorType) {
    try {
        const sensor = await this.dht.read(sensorType, gpio);
        
        if (sensor.isValid) {
            this.setState(`gpio.${gpio}.temperature`, sensor.temperature, true);
            this.setState(`gpio.${gpio}.humidity`, sensor.humidity, true);
        } else {
            this.log.warn(`Invalid reading from DHT sensor on GPIO ${gpio}`);
        }
    } catch (error) {
        this.log.error(`DHT sensor read error on GPIO ${gpio}: ${error.message}`);
    }
}
```

### System Monitoring Pattern
```javascript
// Parser-based system monitoring
async executeParser(parser) {
    try {
        const result = await exec(parser.command);
        const value = this.parseValue(result.stdout, parser);
        
        await this.setObjectNotExistsAsync(parser.id, {
            type: 'state',
            common: {
                name: parser.name,
                type: parser.type || 'mixed',
                role: parser.role || 'value',
                unit: parser.unit,
                read: true,
                write: false
            },
            native: {}
        });
        
        this.setState(parser.id, value, true);
    } catch (error) {
        this.log.error(`Parser ${parser.name} failed: ${error.message}`);
    }
}
```

---

## Hardware-Specific Development Guidelines

### GPIO Safety and Best Practices

- Always validate GPIO pin numbers before use (2-27 for Pi Zero/1/2/3, 2-40 for Pi 4/5)
- Implement proper cleanup to avoid leaving pins in undefined states
- Use appropriate pull-up/pull-down resistors to prevent floating inputs
- Handle hardware initialization failures gracefully (adapter should not crash)
- Provide clear error messages when hardware requirements are not met

### Sensor Integration Best Practices

- Implement retry logic for sensor readings (hardware can be unreliable)
- Use appropriate polling intervals to avoid overwhelming sensors
- Validate sensor data before updating states
- Handle sensor disconnection/reconnection gracefully
- Log sensor errors at appropriate levels (don't spam logs with expected failures)

### Platform Compatibility

```javascript
// Check platform compatibility early
if (process.platform !== 'linux') {
    this.log.error('This adapter requires Linux (Raspberry Pi)');
    this.terminate('Unsupported platform', 11);
}

// Detect Raspberry Pi hardware
const cpuInfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
if (!cpuInfo.includes('Raspberry Pi')) {
    this.log.warn('Hardware does not appear to be a Raspberry Pi. Some features may not work correctly.');
}
```

### Multiple Instance Support

```javascript
// Handle multiple instances properly (added in v2.4.0)
constructor(options = {}) {
    super({
        ...options,
        name: 'rpi2',
        instance: options.instance
    });
    
    this.instanceId = `rpi2.${this.instance}`;
}

// Use instance-specific resource names
getResourceId(resource) {
    return `${this.instanceId}.${resource}`;
}
```

---

## Deployment and Dependencies

### System Dependencies

Hardware adapters often require system-level dependencies:

```json
{
    "os": ["linux"],
    "engines": {
        "node": ">= 18"
    },
    "scripts": {
        "preinstall": "sudo apt-get install -y libgpiod-dev || exit 0"
    }
}
```

### Graceful Dependency Handling

```javascript
// Handle missing native dependencies gracefully
let gpioLib;
try {
    gpioLib = require('opengpio');
} catch (error) {
    this.log.error('GPIO library not available. This adapter requires libgpiod-dev to be installed.');
    this.log.error('Install with: sudo apt-get install libgpiod-dev');
    this.terminate('GPIO library initialization failed', 11);
}
```

### Resource Cleanup

```javascript
async onUnload(callback) {
    try {
        // Clean up intervals and timers
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = undefined;
        }
        
        // Clean up GPIO resources
        if (this.gpioControl) {
            await this.gpioControl.cleanup();
        }
        
        // Clean up DHT sensors
        if (this.dhtSensors) {
            this.dhtSensors.forEach(sensor => sensor.cleanup());
        }
        
        callback();
    } catch (e) {
        callback();
    }
}
```

---

## Documentation

### README Updates

#### Required Sections
1. **Installation** - Clear npm/ioBroker admin installation steps
2. **Configuration** - Detailed configuration options with examples
3. **Usage** - Practical examples and use cases
4. **Changelog** - Version history (use "## **WORK IN PROGRESS**" for ongoing changes)
5. **License** - License information (typically MIT for ioBroker adapters)
6. **Support** - Links to issues, discussions, community support

#### Documentation Standards
- Use clear, concise language
- Include code examples for configuration
- Add screenshots for admin interface when applicable
- Maintain multilingual support (minimum English and German)
- Always reference issues in commits and PRs (e.g., "fixes #xx")

#### Mandatory README Updates for PRs

For **every PR or new feature**, always add a user-friendly entry to README.md:

- Add entries under `## **WORK IN PROGRESS**` section
- Use format: `* (author) **TYPE**: Description of user-visible change`
- Types: **NEW** (features), **FIXED** (bugs), **ENHANCED** (improvements), **TESTING** (test additions), **CI/CD** (automation)
- Focus on user impact, not technical details

**Example:**
```markdown
## **WORK IN PROGRESS**

* (DutchmanNL) **FIXED**: Adapter now properly validates login credentials (fixes #25)
* (DutchmanNL) **NEW**: Added device discovery to simplify initial setup
```

### Changelog Management

Follow the [AlCalzone release-script](https://github.com/AlCalzone/release-script) standard.

#### Format Requirements

```markdown
# Changelog

<!--
  Placeholder for the next version (at the beginning of the line):
  ## **WORK IN PROGRESS**
-->

## **WORK IN PROGRESS**

- (author) **NEW**: Added new feature X
- (author) **FIXED**: Fixed bug Y (fixes #25)

## v0.1.0 (2023-01-01)
Initial release
```

#### Workflow Process
- **During Development:** All changes go under `## **WORK IN PROGRESS**`
- **For Every PR:** Add user-facing changes to WORK IN PROGRESS section
- **Before Merge:** Version number and date added when merging to main
- **Release Process:** Release-script automatically converts placeholder to actual version

#### Change Entry Format
- Format: `- (author) **TYPE**: User-friendly description`
- Types: **NEW**, **FIXED**, **ENHANCED**
- Focus on user impact, not technical implementation
- Reference issues: "fixes #XX" or "solves #XX"

---

## CI/CD & GitHub Actions

### Workflow Configuration

#### GitHub Actions Best Practices

**Must use ioBroker official testing actions:**
- `ioBroker/testing-action-check@v1` for lint and package validation
- `ioBroker/testing-action-adapter@v1` for adapter tests
- `ioBroker/testing-action-deploy@v1` for automated releases with Trusted Publishing (OIDC)

**Configuration:**
- **Node.js versions:** Test on 20.x, 22.x, 24.x
- **Platform:** Use ubuntu-22.04
- **Automated releases:** Deploy to npm on version tags (requires NPM Trusted Publishing)
- **Monitoring:** Include Sentry release tracking for error monitoring

#### Critical: Lint-First Validation Workflow

**ALWAYS run ESLint checks BEFORE other tests.** Benefits:
- Catches code quality issues immediately
- Prevents wasting CI resources on tests that would fail due to linting errors
- Provides faster feedback to developers
- Enforces consistent code quality

**Workflow Dependency Configuration:**
```yaml
jobs:
  check-and-lint:
    # Runs ESLint and package validation
    # Uses: ioBroker/testing-action-check@v1
    
  adapter-tests:
    needs: [check-and-lint]  # Wait for linting to pass
    # Run adapter unit tests
    
  integration-tests:
    needs: [check-and-lint, adapter-tests]  # Wait for both
    # Run integration tests
```

**Key Points:**
- The `check-and-lint` job has NO dependencies - runs first
- ALL other test jobs MUST list `check-and-lint` in their `needs` array
- If linting fails, no other tests run, saving time
- Fix all ESLint errors before proceeding

### Testing Integration

#### API Testing in CI/CD

For adapters with external API dependencies:

```yaml
demo-api-tests:
  if: contains(github.event.head_commit.message, '[skip ci]') == false
  runs-on: ubuntu-22.04
  
  steps:
    - name: Checkout code
      uses: actions/checkout@v4
      
    - name: Use Node.js 20.x
      uses: actions/setup-node@v4
      with:
        node-version: 20.x
        cache: 'npm'
        
    - name: Install dependencies
      run: npm ci
      
    - name: Run demo API tests
      run: npm run test:integration-demo
```

#### Testing Best Practices
- Run credential tests separately from main test suite
- Don't make credential tests required for deployment
- Provide clear failure messages for API issues
- Use appropriate timeouts for external calls (120+ seconds)

#### Package.json Integration
```json
{
  "scripts": {
    "test:integration-demo": "mocha test/integration-demo --exit"
  }
}
```

---

[CUSTOMIZE: Add any adapter-specific coding standards or patterns here]
