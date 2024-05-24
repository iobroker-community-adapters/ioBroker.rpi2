// Which button events will we capture and have states for?
// See https://www.npmjs.com/package/rpi-gpio-buttons
const buttonEvents = [ 'pressed', 'clicked', 'clicked_pressed', 'double_clicked', 'released' ];

class GpioControl {
    constructor(adapter) {
        this.adapter = adapter;
        this.gpio = null;
        this.gpioButtons = null;
        this.config = adapter.config;
        this.debounceTimers = [];
    }

    /**
     * Setup GPIO ports & buttons
     * @param gpioPorts {number[]}
     * @param buttonPorts {number[]}
     * @returns undefined
     */
    setupGpio(gpioPorts, buttonPorts) {
        if (gpioPorts.length === 0 && buttonPorts.length === 0) return;

        this.adapter.log.debug('Inputs are pull ' + (this.config.inputPullUp ? 'up' : 'down') + '.');
        this.adapter.log.debug('Buttons are pull ' + (this.config.buttonPullUp ? 'up' : 'down') + '.');

        try {
            this.gpio = require('rpi-gpio');
            this.gpio.setMode(this.gpio.MODE_BCM);
        } catch (e) {
            this.gpio = null;
            this.adapter.log.error('Cannot initialize/setMode GPIO: ' + e);
            console.error(e);
            if (e.message.includes('NODE_MODULE_VERSION')) {
                return this.adapter.terminate('A dependency requires a rebuild.', 13);
            }
        }

        if (this.gpio) {
            // Our GPIO init worked, setup regular I/O & buttons.
            let haveGpioInputs = false;

            // Setup all the regular GPIO input and outputs.
            for (const port of gpioPorts) {
                const direction = this.config.gpios[port].input;
                this.adapter.log.debug(`Port ${port} direction: ${direction}`);
                if (direction === 'in') {
                    // Input port
                    haveGpioInputs = true;
                    this.gpio.setup(port, this.gpio.DIR_IN, this.gpio.EDGE_BOTH, (err) => {
                        if (err) {
                            this.adapter.log.error('Cannot setup port ' + port + ' as input: ' + err);
                        } else {
                            this.readValue(port);
                        }
                    });
                } else {
                    // All the different flavors of output
                    const directionCode = direction === 'outlow' ? this.gpio.DIR_LOW : direction === 'outhigh' ? this.gpio.DIR_HIGH : this.gpio.DIR_OUT;
                    this.adapter.log.debug(`Port ${port} directionCode: ${directionCode}`);
                    this.gpio.setup(port, directionCode, (err) => {
                        err && this.adapter.log.error('Cannot setup port ' + port + ' as output: ' + err);
                    });
                }
            }

            // Setup input change handler - only has to be done once no matter how many inputs we have.
            if (haveGpioInputs) {
                this.adapter.log.debug('Register onchange handler');
                this.gpio.on('change', (port, value) => {
                    // Ignore buttons as they are handled below
                    if (this.adapter.config.gpios[port].input === 'in') {
                        this.adapter.log.debug('GPIO change on port ' + port + ': ' + value);
                        if (this.debounceTimers[port] !== null) {
                            // Timer is running, but the state changed (must be back) so just cancel timer.
                            clearTimeout(this.debounceTimers[port]);
                            this.debounceTimers[port] = null;
                        } else {
                            // Start a timer and report to state if it doesn't revert within a given period.
                            this.debounceTimers[port] = setTimeout(async (t_port, t_value) => {
                                this.debounceTimers[t_port] = null;
                                this.adapter.log.debug(`GPIO debounced on port ${t_port}: ${t_value}`);
                                await this.adapter.setStateAsync('gpio.' + t_port + '.state', this.inputPullUp(t_value), true);
                            }, this.config.inputDebounceMs, port, value);
                        }
                    }
                });
            }

            // Setup any buttons using the same rpi-gpio object as other I/O.
            if (buttonPorts.length > 0) {
                this.adapter.log.debug(`Setting up button ports: ${buttonPorts}`);
                try {
                    const rpi_gpio_buttons = require('rpi-gpio-buttons');
                    this.gpioButtons = new rpi_gpio_buttons({
                        pins: buttonPorts,
                        usePullUp: this.config.buttonPullUp,
                        timing: {
                            debounce: this.config.buttonDebounceMs,
                            pressed: this.config.buttonPressMs,
                            clicked: this.config.buttonDoubleMs
                        },
                        gpio: this.gpio
                    });
                } catch (e) {
                    this.gpioButtons = null;
                    this.adapter.log.error('Cannot initialize GPIO Buttons: ' + e);
                    console.error(e);
                    if (e.message.includes('NODE_MODULE_VERSION')) {
                        return this.adapter.terminate('A dependency requires a rebuild.', 13);
                    }
                }

                // Setup events for buttons - only has to be done once no matter how many buttons we have.
                if (this.gpioButtons) {
                    for (const eventName of buttonEvents) {
                        this.adapter.log.debug(`Register button handler for ${eventName}`);
                        this.gpioButtons.on(eventName, async (port) => {
                            this.adapter.log.debug(`${eventName} triggered for port ${port}`);
                            const stateName = `gpio.${port}.${eventName}`;
                            await this.adapter.setStateAsync(stateName, true, true);
                        });
                    }
                    // And start button processing
                    this.gpioButtons.init().catch(err => {
                        this.adapter.log.error(`An error occurred during buttons init(). ${err.message}`);
                    });
                }
            }
        }
    }

    /**
     * Read the value of a GPIO port and update the corresponding state.
     * @param port {number}
     * @returns {Promise<void> | void}
     */
    readValue(port) {
        if (!this.gpio) {
            return this.adapter.log.error('GPIO is not initialized!');
        }

        this.gpio.read(port, async (err, value) => {
            if (err) {
                this.adapter.log.error('Cannot read port ' + port + ': ' + err);
            } else {
                await this.adapter.setStateAsync('gpio.' + port + '.state', this.inputPullUp(value), true);
            }
        });
    }

    /**
     * Write a value to a GPIO port and update the corresponding state.
     * @param port {number|string}
     * @param value {boolean|string}
     */
    writeGpio(port, value) {
        port = parseInt(port, 10);
        if (!this.config.gpios[port] || !this.config.gpios[port].enabled) {
            this.adapter.log.warn('Port ' + port + ' is not writable, because disabled.');
            return;
        } else if (this.config.gpios[port].input === 'in' || this.config.gpios[port].input === 'true' || this.config.gpios[port].input === true) {
            return this.adapter.log.warn('Port ' + port + ' is configured as input and not writable');
        }

        if (value === 'true')  value = true;
        if (value === 'false') value = false;
        if (value === '0')     value = false;
        value = !!value;

        try {
            if (this.gpio) {
                this.gpio.write(port, value, async err => {
                    if (err) {
                        this.adapter.log.error(err);
                    } else {
                        this.adapter.log.debug('Written ' + value + ' into port ' + port);
                        await this.adapter.setStateAsync('gpio.' + port + '.state', value, true);
                    }
                });
            } else {
                this.adapter.log.error('GPIO is not initialized!');
            }
        } catch (error) {
            this.adapter.log.error('Cannot write port ' + port + ': ' + error);
        }
    }

    /**
     * Converts value depending on inputPullUp setting.
     * @param value {boolean}
     * @returns {boolean}
     */
    inputPullUp(value) {
        return (this.config.inputPullUp ? !value : value);
    }

    /**
     * Cleanup on unload.
     * @returns {Promise<void>}
     */
    async unload() {
        // Cancel any debounceTimers
        for (const timer of this.debounceTimers) {
            if (timer != null) {
                clearTimeout(timer);
            }
        }
        if (this.gpio) {
            if (this.gpioButtons) {
                await this.gpioButtons.destroy().catch((err) => {
                    console.error(`Failed to destroy gpioButtons: ${err}`);
                });
            }
            await this.gpio.promise.destroy().catch((err) => {
                console.error(`Failed to destroy gpio: ${err}`);
            });
        }
    }
}

exports.buttonEvents = buttonEvents;
exports.GpioControl = GpioControl;
