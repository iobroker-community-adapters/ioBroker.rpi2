'use strict';

const { expect } = require('chai');
const parsers = require('./lib/parsers.json');

describe('parser definitions', () => {
    it('should define temperature fan activity parser', () => {
        expect(parsers.temperature).to.have.property('fan_activity');
        expect(parsers.temperature.fan_activity).to.deep.equal({
            command: 'cat /sys/devices/platform/cooling_fan/hwmon/hwmon1/fan1_input',
            regexp: '(.*)',
            post: '',
            role: 'value.speed',
        });
    });
});
