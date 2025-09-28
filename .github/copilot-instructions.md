# ioBroker Adapter Development with GitHub Copilot

**Version:** 0.4.0
**Template Source:** https://github.com/DrozmotiX/ioBroker-Copilot-Instructions

This file contains instructions and best practices for GitHub Copilot when working on ioBroker adapter development.

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

## Testing

### Unit Testing
- Use Jest as the primary testing framework for ioBroker adapters
- Create tests for all adapter main functions and helper methods
- Test error handling scenarios and edge cases
- Mock external API calls and hardware dependencies
- For adapters connecting to APIs/devices not reachable by internet, provide example data files to allow testing of functionality without live connections
- Example test structure:
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

**IMPORTANT**: Use the official `@iobroker/testing` framework for all integration tests. This is the ONLY correct way to test ioBroker adapters.

**Official Documentation**: https://github.com/ioBroker/testing

#### Framework Structure
Integration tests MUST follow this exact pattern:

```javascript
const path = require('path');
const { tests } = require('@iobroker/testing');

// Define test coordinates or configuration
const TEST_COORDINATES = '52.520008,13.404954'; // Berlin
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Use tests.integration() with defineAdditionalTests
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
                        harness = getHarness();
                        
                        // Get adapter object using promisified pattern
                        const obj = await new Promise((res, rej) => {
                            harness.objects.getObject('system.adapter.your-adapter.0', (err, o) => {
                                if (err) return rej(err);
                                res(o);
                            });
                        });
                        
                        if (!obj) {
                            return reject(new Error('Adapter object not found'));
                        }

                        // Configure adapter properties
                        Object.assign(obj.native, {
                            position: TEST_COORDINATES,
                            createCurrently: true,
                            createHourly: true,
                            createDaily: true,
                            // Add other configuration as needed
                        });

                        // Set the updated configuration
                        harness.objects.setObject(obj._id, obj);

                        console.log('✅ Step 1: Configuration written, starting adapter...');
                        
                        // Start adapter and wait
                        await harness.startAdapterAndWait();
                        
                        console.log('✅ Step 2: Adapter started');

                        // Wait for adapter to process data
                        const waitMs = 15000;
                        await wait(waitMs);

                        console.log('🔍 Step 3: Checking states after adapter run...');
                        
                        // Check if expected states were created
                        const states = await harness.states.getKeysAsync('your-adapter.0.*');
                        console.log(`Found ${states.length} states`);
                        
                        if (states.length === 0) {
                            return reject(new Error('No states were created by the adapter'));
                        }

                        resolve();
                    } catch (error) {
                        console.error('Integration test error:', error);
                        reject(error);
                    }
                });
            });
        });
    }
});
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

### Testing Best Practices

- **Always check basic adapter functionality first**: Verify the adapter starts, creates expected states, and handles configuration properly
- **Use timeout protection**: Set appropriate timeouts for tests that depend on intervals or external responses
- **Provide clear error messages**: Include enough context in test failures to identify the root cause quickly  
- **Test configuration edge cases**: Empty configs, invalid GPIO pins, conflicting settings
- **Mock hardware dependencies**: Use Jest mocks or stubs for GPIO and sensor libraries in CI environments

## ioBroker Integration Patterns

### Adapter Lifecycle Management

Follow the standard ioBroker adapter lifecycle pattern:

```javascript
class YourAdapter extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'your-adapter',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        // Initialize adapter
        this.setState('info.connection', false, true);
        // Setup subscriptions and start main functionality
        await this.subscribeStatesAsync('*');
    }

    onStateChange(id, state) {
        if (!state || state.ack) return;
        // Handle state changes from user/other adapters
    }

    async onUnload(callback) {
        try {
            // Clean up resources, close connections
            clearInterval(this.refreshInterval);
            callback();
        } catch (e) {
            callback();
        }
    }
}
```

### State and Object Management

```javascript
// Create states with proper common properties
await this.setObjectNotExistsAsync('temperature', {
    type: 'state',
    common: {
        name: 'Temperature',
        type: 'number',
        role: 'value.temperature',
        unit: '°C',
        read: true,
        write: false,
    },
    native: {},
});

// Update state values with proper acknowledge flag
this.setState('temperature', { val: 22.5, ack: true });
```

### Error Handling and Logging

```javascript
// Use appropriate log levels
this.log.error('Critical error that prevents normal operation');
this.log.warn('Warning about potential issues');
this.log.info('Important information for users');
this.log.debug('Detailed information for debugging');

// Handle errors gracefully
try {
    await someAsyncOperation();
} catch (error) {
    this.log.error(`Operation failed: ${error.message}`);
    this.setState('info.connection', false, true);
}
```

### Hardware Integration Patterns for RPI2

The RPI2 adapter has specific patterns for hardware integration:

#### GPIO Control Pattern
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

#### DHT Sensor Integration Pattern
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

#### System Monitoring Pattern
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

## Configuration Management

### JSON Config Structure for Hardware Adapters

The RPI2 adapter uses JSONConfig for its admin interface. Follow these patterns:

```javascript
// GPIO configuration array structure
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

### Configuration Validation

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

## Deployment and Dependencies

### System Dependencies

Hardware adapters often require system-level dependencies:

```javascript
// package.json system requirements
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

## Code Style and Standards

- Follow JavaScript/TypeScript best practices
- Use async/await for asynchronous operations
- Implement proper resource cleanup in `unload()` method
- Use semantic versioning for adapter releases
- Include proper JSDoc comments for public methods

## CI/CD and Testing Integration

### GitHub Actions for Hardware Adapters

For adapters with hardware dependencies, structure CI/CD to handle missing libraries gracefully:

```yaml
test:
  runs-on: ubuntu-latest
  
  steps:
    - name: Checkout code
      uses: actions/checkout@v4
      
    - name: Use Node.js 20.x
      uses: actions/setup-node@v4
      with:
        node-version: 20.x
        cache: 'npm'
        
    - name: Install system dependencies
      run: |
        sudo apt-get update
        sudo apt-get install -y libgpiod-dev || echo "GPIO dev libs not available in CI"
        
    - name: Install dependencies
      run: npm ci --ignore-scripts
      
    - name: Run tests
      run: npm test
```

### Package.json Scripts for Hardware Testing

```json
{
  "scripts": {
    "test": "npm run test:js && npm run test:package",
    "test:js": "mocha --config test/mocharc.custom.json \"{!(node_modules|test)/**/*.test.js,*.test.js,test/**/test!(PackageFiles|Startup).js}\"",
    "test:package": "mocha test/package --exit",
    "test:integration": "mocha test/integration --exit",
    "test:gpio": "mocha test/gpio --exit || echo 'GPIO tests skipped (hardware not available)'"
  }
}
```

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