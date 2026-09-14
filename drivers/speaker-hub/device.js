'use strict';

const YoLinkDevice = require('../yoLinkDevice');

module.exports = class SpeakerHubDevice extends YoLinkDevice
{

	/**
	 * onInit is called when the device is initialized.
	 */
	async onInit()
	{
		this.refreshState().catch(this.error);
		this.homey.app.updateLog('SpeakerHubDevice has been initialized');
	}

	/**
	 * onAdded is called when the user adds the device, called just after pairing.
	 */
	async onAdded()
	{
		this.refreshState().catch(this.error);
		this.homey.app.updateLog('SpeakerHubDevice has been added');
	}

	/**
	 * onSettings is called when the user updates the device's settings.
	 * @param {object} event the onSettings event data
	 * @param {object} event.oldSettings The old settings object
	 * @param {object} event.newSettings The new settings object
	 * @param {string[]} event.changedKeys An array of keys changed since the previous version
	 * @returns {Promise<string|void>} return a custom message that will be displayed
	 */
	async onSettings({ oldSettings, newSettings, changedKeys })
	{
		this.homey.app.updateLog('SpeakerHubDevice settings were changed');
	}

	/**
	 * onRenamed is called when the user updates the device's name.
	 * This method can be used this to synchronise the name to the device.
	 * @param {string} name The new name
	 */
	async onRenamed(name)
	{
		this.homey.app.updateLog('SpeakerHubDevice was renamed');
	}

	/**
	 * onDeleted is called when the user deleted the device.
	 */
	async onDeleted()
	{
		this.homey.app.updateLog('SpeakerHubDevice has been deleted');
	}

	async updateState()
	{
		try
		{
			const data = await this.getData();
			const settings = await this.getSettings();
			const state = await this.driver.getState(data, settings);

			if (!state || !state.data || !state.data.wifi || !state.data.wifi.ip)
			{
				const unavailableMessage = (state && typeof state.desc === 'string' && state.desc.length > 0)
					? state.desc
					: 'Offline';
				this.setUnavailable(unavailableMessage).catch(this.error);
				return false;
			}

			this.setAvailable().catch(this.error);

			// Log the device status
			this.homey.app.updateLog(`SpeakerHubDevice MQTT message received: ${JSON.stringify(state)}`);

			this.setCapabilityValue('info', state.data.wifi.ip).catch(this.error);
			return true;
		}
		catch (error)
		{
			this.homey.app.updateLog(`SpeakerHubDevice updateState failed: ${error.message}`, 0);
			this.setUnavailable('Offline').catch(this.error);
			return false;
		}
	}
};
