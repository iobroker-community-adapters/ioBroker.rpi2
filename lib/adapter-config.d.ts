// This file extends the AdapterConfig type from "@types/iobroker"
// using the actual properties present in io-package.json
// in order to provide typings for adapter.config properties

import { native } from '../io-package.json';

// One row of the GPIO table in admin/jsonConfig.json.
// io-package.json only holds an empty default array, so the row type is declared here.
interface GpioSetting {
    gpio: number;
    configuration: 'in' | 'out' | 'outlow' | 'outhigh' | 'button' | 'dht11' | 'dht22';
    debounceOrPoll?: number;
    pullUp?: boolean;
    pullDown?: boolean;
    invert?: boolean;
    label?: string;
}

type _AdapterConfig = Omit<typeof native, 'gpioSettings'> & {
    gpioSettings: GpioSetting[];
};

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface AdapterConfig extends _AdapterConfig {
            // Do not enter anything here!
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};