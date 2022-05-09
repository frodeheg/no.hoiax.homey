'use strict';

const { privateEncrypt } = require('crypto');
const { OAuth2Device } = require('homey-oauth2app');

class MyHoiaxDevice extends OAuth2Device {

  async setHeaterState(deviceId, turn_on, new_power) {
    // 1) Send commands to device
    //    Value 0 = Off, 1 = 700W, 2 = 1300W, 3 = 2000W
    let power = turn_on ? new_power : 0
    const onoff_response = await this.oAuth2Client.setDevicePoint(deviceId, { '517': power });
    if (onoff_response.ok === false) {
      throw new Error('Unable to Control device - Failed to power on/off');
    }
    // 2) Set capability states
    let new_power_text = (new_power == 1) ? "low_power" : (new_power == 2) ? "medium_power" : "high_power"
    let new_power_watt = (new_power == 1) ?         700 : (new_power == 2) ? 1300           : 2000
    this.setCapabilityValue('onoff', turn_on).catch(this.error)
    this.setCapabilityValue('max_power', new_power_text).catch(this.error)

    // 3) Send trigger action
    if (new_power != this.max_power) {
      const tokens = { 'max_power': new_power_watt };
      this.driver.ready().then(() => {
        this.driver.triggerMaxPowerChanged(this, tokens, {})
      })
    }
    // 4) Set internal state
    this.is_on = turn_on
    this.max_power = new_power
  }


  /**
   * onOAuth2Init is called when the device is initialized.
   */
   async onOAuth2Init() {
      this.log('MyHoiaxDevice was initialized');
      this.deviceId = this.getData().deviceId

      // Make sure that the Heater mode is controllable - set to External mode
      const heater_mode = await this.oAuth2Client.getDevicePoints(this.deviceId, '500');
      if (heater_mode[0] == undefined) {
        throw new Error('Problems reading heater mode: ' + heater_mode.message);
      } else if (heater_mode[0].value != 8) { // 8 == External
        let res = undefined
        try {
          res = await this.oAuth2Client.setDevicePoint(this.deviceId, { '500': '8' });
        }
        catch(err) {
          if (res == undefined || res.ok === false) {
            throw new Error('Unable to Control device - Failed to put it into External mode');
          }
        }
      }

      // Set heater max power to 2000 W
      this.max_power = 3
      this.is_on = true

      // Update internal setup state once only
      const internal_state = await this.oAuth2Client.getDevicePoints(this.deviceId, '100,101,511,512,516');
      await this.setSettings({
        ambient_temperature: internal_state[0].value, // 100
        inlet_temperature:   internal_state[1].value, // 101
        legionella_frequency:internal_state[2].value, // 511
        max_water_flow:      internal_state[3].value, // 512
        regulation_diff:     internal_state[4].value, // 516
      });
  
      // Update internal state every 5 minute:
      await this.updateState(this.deviceId)
      setInterval(() => {
        this.updateState(this.deviceId)
      }, 1000*60*5)
      
      // Custom flows
      const OnMaxPowerAction  = this.homey.flow.getActionCard('change-maxpower')

      OnMaxPowerAction.registerRunListener(async (state) => {
        await this.setHeaterState(
          this.deviceId,
          this.is_on,
          (state['max_power'] == "low_power") ? 1 :
          (state['max_power'] == "medium_power") ? 2 : 3 )
      })

      // Register on/off handling
      this.registerCapabilityListener('onoff', async (turn_on) => {
        await this.setHeaterState(this.deviceId, turn_on, this.max_power)
      })
      // Register max power handling
      this.registerCapabilityListener('max_power', async (value) => {
        let new_power = 3 // High power
        if (value == 'low_power') {
          new_power = 1
        } else if (value == 'medium_power') {
          new_power = 2
        }
        await this.setHeaterState(this.deviceId, this.is_on, new_power)
      })

      // Register target temperature handling
      this.registerCapabilityListener('target_temperature', async (value) => {
        const target_temp = await this.oAuth2Client.setDevicePoint(this.deviceId, { '527': value });
        if (target_temp.ok === false) {
          throw new Error('Unable to Control device - Failed to set target temperature');
        }
        this.log('Target temp:', value)
      })
    }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log("Settings changed")
    
    if (changedKeys.includes("ambient_temperature")) {
      this.log("Ambient temperature changed: ", newSettings.ambient_temperature)
      const response = await this.oAuth2Client.setDevicePoint(this.deviceId, { '100': newSettings.ambient_temperature });
      if (response.ok === false) {
        throw new Error('Unable to Control device - Failed to set Ambient temperature');
      }
    }
    if (changedKeys.includes("inlet_temperature")) {
      this.log("Inlet temperature changed: ", newSettings.inlet_temperature)
      const response = await this.oAuth2Client.setDevicePoint(this.deviceId, { '101': newSettings.inlet_temperature });
      if (response.ok === false) {
        throw new Error('Unable to Control device - Failed to set Inlet temperature');
      }
    }
    if (changedKeys.includes("max_water_flow")) {
      this.log("Max water flow changed: ", newSettings.max_water_flow)
      const response = await this.oAuth2Client.setDevicePoint(this.deviceId, { '512': newSettings.max_water_flow });
      if (response.ok === false) {
        throw new Error('Unable to Control device - Failed to set max water flow');
      }
    }
    if (changedKeys.includes("regulation_diff")) {
      this.log("Regulation diff changed: ", newSettings.regulation_diff)
      const response = await this.oAuth2Client.setDevicePoint(this.deviceId, { '516': newSettings.regulation_diff });
      if (response.ok === false) {
        throw new Error('Unable to Control device - Failed to set regulation diff');
      }
    }
    if (changedKeys.includes("legionella_frequency")) {
      this.log("Legionella frequency changed: ", newSettings.legionella_frequency)
      const response = await this.oAuth2Client.setDevicePoint(this.deviceId, { '511': newSettings.legionella_frequency });
      if (response.ok === false) {
        throw new Error('Unable to Control device - Failed to set Legionella program frequency');
      }
    }
  }

  async updateState(deviceId) {
    const dev_points = await this.oAuth2Client.getDevicePoints(deviceId, '302,303,400,404,517,527,528');
    this.setCapabilityValue('meter_power.in_tank', dev_points[0].value) // 302 = EnergyStored
    this.setCapabilityValue('meter_power.accumulated', dev_points[1].value) // 303 = EnergyTotal
    this.setCapabilityValue('measure_power', dev_points[2].value) // 400 = EstimatedPower
    this.setCapabilityValue('measure_humidity.fill_level', dev_points[3].value) //404 = FillLevel
    //this.setCapabilityValue('measure_humidity.efficiency', dev_points[4].value) //405 = HeaterEfficiency
    let current_max_power = dev_points[4].value // 517 = Requested power
    // Value 0 = Off, 1 = 700W, 2 = 1300W, 3 = 2000W
    if (current_max_power == 0) {
      // Heater is off
      this.is_on     = false
    } else {
      this.is_on     = true
      this.max_power = current_max_power
    }
    this.setHeaterState(deviceId, this.is_on, this.max_power)
    this.setCapabilityValue('target_temperature', dev_points[5].value) // 527 = Requested temperature
    this.setCapabilityValue('measure_temperature', dev_points[6].value) // 528 = Measured temperature
  }

  async onOAuth2Deleted() {
    // Clean up here
    this.log('MyHoiaxDevice was deleted');
  }

}

module.exports = MyHoiaxDevice;
