const obsoleteFields = [
    //buttons deprecated for now, but lets keep their settings a while until a final decision is made.
    //'buttonPressMs', //deprecated for now
    //'buttonDoubleMs', //deprecated for now
    'buttonPullUp', //deprecated for now
    'buttonDebounceMs', //deprecated for now

    'inputPullUp', //now a per gpio setting
    'inputDebounceMs', //now a per gpio setting
    'dhtPollInterval', //now a per gpio setting
    'inputPollIntervalMs', //seems to be already deprecated
    //old parser stuff:
    'cpu', 'raspberry', 'memory', 'network', 'sdcard', 'swap', 'temperature', 'uptime', 'wlan'
];

exports.convertConfig = function (currentConfig, adapter) {
    let changed = false;
    const logging = ['Updating config from \n', JSON.stringify(currentConfig, null, 2), '\nto\n'];
    const defaultDebounceInterval = currentConfig.inputDebounceMs;
    const defaultInputPullUp = currentConfig.inputPullUp;
    const dhtPollInterval = currentConfig.dhtPollInterval;
    //first, let's get rid of old in config parser stuff:
    for (const obsoleteField of obsoleteFields) {
        if (currentConfig[obsoleteField] !== undefined) {
            delete currentConfig[obsoleteField];
            changed = true;
        }
    }

    if (!currentConfig.gpioSettings) {
        currentConfig.gpioSettings = [];
    }
    if (currentConfig.gpios) {
        changed = true;
        for (let i = 0; i < currentConfig.gpios.length; i++) {
            const gpio = currentConfig.gpios[i];
            if (gpio !== null && gpio.enabled) {
                //handle old boolean input settings
                if (typeof gpio.input === 'boolean') {
                    gpio.input = gpio.input ? 'in' : 'out';
                }
                if (gpio.input === 'true') {
                    gpio.input = 'in';
                }
                if (gpio.input === 'false') {
                    gpio.input = 'out';
                }

                const newGpio = {
                    gpio: i,
                    label: gpio.label,
                    configuration: gpio.input
                };
                switch (gpio.input) {
                    case 'button': {
                        newGpio.debounceOrPoll = currentConfig.buttonDebounceMs;
                        newGpio.pullUp = currentConfig.buttonPullUp;
                        break;
                    }
                    case 'in': {
                        newGpio.debounceOrPoll = defaultDebounceInterval;
                        newGpio.pullUp = defaultInputPullUp;
                        break;
                    }
                    case 'dht11':
                    case 'dht22': {
                        newGpio.debounceOrPoll = dhtPollInterval;
                        break;
                    }
                }

                const alreadyConfiguredGPIO = currentConfig.gpioSettings.find(g => g.gpio === i);
                if (alreadyConfiguredGPIO) {
                    adapter.log.warn(`GPIO ${i} already configured. Skipping old settings ${JSON.stringify(gpio)}.`);
                } else {
                    currentConfig.gpioSettings.push(newGpio);
                }
            }
        }
    }
    delete currentConfig.gpios;

    if (changed) {
        logging.push(JSON.stringify(currentConfig, null, 2));
        logging.push('\n');
        adapter.log.debug(logging.join(''));
    }

    return changed;
};

