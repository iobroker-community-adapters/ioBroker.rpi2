'use strict';

const { expect } = require('chai');
const parsers = require('./lib/parsers.json');

describe('parser definitions', () => {
    it('should define temperature fan activity parser', () => {
        expect(parsers.temperature).to.have.property('fan_activity');
        expect(parsers.temperature.fan_activity).to.deep.equal({
            command:
                'test -r /sys/devices/platform/cooling_fan/hwmon/hwmon1/fan1_input && cat /sys/devices/platform/cooling_fan/hwmon/hwmon1/fan1_input || echo "0"',
            regexp: '(\\d+)',
            post: '',
            role: 'value.speed',
        });
    });

    it('should capture fan RPM values with the configured regexp', () => {
        const fanRegexp = new RegExp(parsers.temperature.fan_activity.regexp);
        const match = fanRegexp.exec('3200\n');
        expect(match).to.exist;
        expect(match[1]).to.equal('3200');
    });

    it('should capture fallback fan value when fan hardware is unavailable', () => {
        const fanRegexp = new RegExp(parsers.temperature.fan_activity.regexp);
        const match = fanRegexp.exec('0\n');
        expect(match).to.exist;
        expect(match[1]).to.equal('0');
    });
});
