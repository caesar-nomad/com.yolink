/* eslint-disable operator-linebreak */
/* eslint-disable no-tabs */

'use strict';

/** *******************************************************************************
** YoLink API interface ***
** See http://doc.yosmart.com/docs/protocol/openAPIV2/en.html for details  **
******************************************************************************** */
const
	{
		SimpleClass,
	} = require('homey');

const mqtt = require('./mqtt');

// const fetch = require('node-fetch'); // Only needed for Node.js < 18

const yoLinkApi = {
	cloudUrl_us: 'https://api.yosmart.com/open/yolink/',
	cloudUrl_eu: 'https://api-eu.yosmart.com/open/yolink/',
	mqttUrl_us: 'mqtt://api.yosmart.com',
	mqttUrl_eu: 'mqtt://api-eu.yosmart.com',
	localUrl: 'http://IP:1080/open/yolink/',
	apiUrl: 'v2/api',
};

module.exports = class YoLinkAPI extends SimpleClass
{
	constructor(app)
	{
		super();
		this.app = app;

		// this.UAIDList is used to store the list of objects {UAID: <UAID>, access_token: <accessToken>, refresh_token: <refreshToken>, expires_at: <expires_at>}
		this.UAIDList = this.app.homey.settings.get('UAIDList') || [];
		this.normalizeStoredUAIDList();
		this.MQTTList = []; // List of {UAID, serviceZoneID, MQTTClient}
		this.tokenRefreshPromises = {}; // Keyed by UAID
		this.mqttSetupPromises = {}; // Keyed by UAID_serviceZoneID
	}

	normalizeUAID(value)
	{
		if (typeof value !== 'string')
		{
			return '';
		}

		const trimmed = value.trim();
		if (!trimmed)
		{
			return '';
		}

		const noPrefix = trimmed.replace(/^ua_/i, '');
		if (/^[A-Fa-f0-9]{32}$/.test(noPrefix))
		{
			return `ua_${noPrefix.toUpperCase()}`;
		}

		return trimmed;
	}

	isValidNormalizedUAID(uaid)
	{
		return typeof uaid === 'string' && /^ua_[A-F0-9]{32}$/.test(uaid);
	}

	getTokenFailureReason(message)
	{
		const msg = typeof message === 'string' ? message.toLowerCase() : '';
		if (msg.includes('client_id not existed'))
		{
			return 'invalid_client_id';
		}
		if (msg.includes('not support'))
		{
			return 'unsupported_client_id_format';
		}
		if (msg.includes('auth failed'))
		{
			return 'auth_failed';
		}
		if (msg.includes('invalid_client'))
		{
			return 'invalid_client';
		}
		if (msg.includes('invalid_grant'))
		{
			return 'invalid_grant';
		}
		if (msg.includes('timeout') || msg.includes('network') || msg.includes('fetch'))
		{
			return 'transport_error';
		}
		return 'unknown';
	}

	getTokenFailureHint(reason, zone, grantType)
	{
		switch (reason)
		{
		case 'invalid_client_id':
			return 'YoLink did not recognize this UAID in the selected region.';
		case 'unsupported_client_id_format':
			return 'The UAID format is not supported by YoLink.';
		case 'auth_failed':
			if (grantType === 'refresh_token')
			{
				return `Refresh token rejected in ${zone.toUpperCase()} zone.`;
			}
			return `Credentials were rejected in ${zone.toUpperCase()} zone.`;
		case 'invalid_client':
			return 'Client authentication failed.';
		case 'invalid_grant':
			return 'Refresh token grant was rejected.';
		case 'transport_error':
			return 'Network/transport issue while contacting YoLink token service.';
		default:
			return 'Token request failed for an unknown reason.';
		}
	}

	getTokenFailureUserAction(reason, zone, grantType)
	{
		switch (reason)
		{
		case 'invalid_client_id':
			return `Please verify the UAID in the YoLink app and try again in ${zone.toUpperCase()} zone.`;
		case 'unsupported_client_id_format':
			return 'Please paste the full UAID exactly as shown in YoLink (format: ua_ + 32 characters).';
		case 'auth_failed':
			if (grantType === 'refresh_token')
			{
				return 'Please reconnect the account (re-enter UAID + Secret Key) to get a fresh token.';
			}
			return `Please check the Secret Key and try the other region if needed (US/EU). Current region: ${zone.toUpperCase()}.`;
		case 'invalid_client':
			return 'Please confirm UAID and Secret Key belong to the same YoLink account.';
		case 'invalid_grant':
			return 'Please re-enter UAID and Secret Key to refresh authentication.';
		case 'transport_error':
			return 'Please check internet connectivity and retry in a moment.';
		case 'unexpected_response_format':
			return 'YoLink returned an unexpected response. Please retry; if it continues, send diagnostics.';
		default:
			return 'Please retry and, if it fails again, send diagnostics to support.';
		}
	}

	normalizeTokenResponse(data, UAID, serviceZoneID, grantType)
	{
		if (!data || typeof data !== 'object' || Array.isArray(data))
		{
			const preview = typeof data === 'string' ? data.substring(0, 160) : this.app.varToString(data);
			return {
				state: 'error',
				msg: `Unexpected non-JSON token response: ${preview}`,
				reason: 'unexpected_response_format',
				hint: 'Token endpoint did not return expected JSON payload.',
				zone: serviceZoneID,
				grantType,
				UAID,
			};
		}

		if (data.state === 'error' || !data.access_token)
		{
			const msg = typeof data.msg === 'string' && data.msg ? data.msg : 'Unknown token error';
			const reason = this.getTokenFailureReason(msg);
			return {
				...data,
				state: 'error',
				msg,
				reason,
				hint: this.getTokenFailureHint(reason, serviceZoneID, grantType),
				zone: serviceZoneID,
				grantType,
				UAID,
			};
		}

		return {
			...data,
			state: data.state || 'ok',
			zone: serviceZoneID,
			grantType,
			UAID,
		};
	}

	logTokenFailure(prefix, tokenData)
	{
		const details = tokenData && typeof tokenData === 'object' ? tokenData : {};
		const zone = details.zone || 'us';
		const reason = details.reason || this.getTokenFailureReason(details.msg);
		const hint = details.hint || this.getTokenFailureHint(reason, zone, details.grantType || 'client_credentials');
		const action = this.normalizeUserAction(this.getTokenFailureUserAction(reason, zone, details.grantType || 'client_credentials'));
		const msg = details.msg || 'Unknown error';
		this.app.updateLog(`${prefix}. What you can do: ${action} | diag: zone=${zone} grant=${details.grantType || 'unknown'} reason=${reason} msg=${msg} hint=${hint}`, 0);
	}

	normalizeUserAction(action)
	{
		const actionText = typeof action === 'string' ? action.trim() : '';
		if (!actionText)
		{
			return 'Please retry and, if it fails again, send diagnostics to support.';
		}

		if (/^please\b/i.test(actionText))
		{
			return actionText;
		}

		return `Please ${actionText.charAt(0).toLowerCase()}${actionText.slice(1)}`;
	}

	logUserFixableFailure(prefix, action, diag = {})
	{
		const normalizedAction = this.normalizeUserAction(action);
		const diagEntries = Object.entries(diag)
			.filter(([, value]) => value !== null && value !== undefined && value !== '')
			.map(([key, value]) => `${key}=${String(value).replace(/\s+/g, ' ').trim()}`);
		const diagSuffix = diagEntries.length > 0 ? ` | diag: ${diagEntries.join(' ')}` : '';
		this.app.updateLog(`${prefix}. What you can do: ${normalizedAction}${diagSuffix}`, 0);
	}

	normalizeStoredUAIDList()
	{
		if (!Array.isArray(this.UAIDList) || this.UAIDList.length === 0)
		{
			this.UAIDList = [];
			return;
		}

		const normalizedList = [];
		const seenUAID = new Set();

		for (const entry of this.UAIDList)
		{
			if (!entry || typeof entry !== 'object')
			{
				continue;
			}

			const normalizedUAID = this.normalizeUAID(entry.UAID);
			if (!normalizedUAID || !this.isValidNormalizedUAID(normalizedUAID) || seenUAID.has(normalizedUAID))
			{
				continue;
			}

			seenUAID.add(normalizedUAID);
			normalizedList.push({
				...entry,
				UAID: normalizedUAID,
				serviceZoneID: entry.serviceZoneID === 'eu' ? 'eu' : 'us',
			});
		}

		if (normalizedList.length !== this.UAIDList.length)
		{
			this.app.updateLog(`Normalized UAIDList from ${this.UAIDList.length} to ${normalizedList.length} entries`);
		}

		this.UAIDList = normalizedList;
		this.app.homey.settings.set('UAIDList', this.UAIDList);
	}

	async getUAIDList()
	{
		// Return the array of UAIDs
		return this.UAIDList.map((item) => item.UAID);
	}

	formatDateForLog(value)
	{
		const date = new Date(value);
		return Number.isFinite(date.getTime()) ? date.toISOString() : `invalid date (${String(value)})`;
	}

	safeJsonStringify(value)
	{
		try
		{
			return JSON.stringify(value);
		}
		catch (error)
		{
			return `unserializable value: ${error.message}`;
		}
	}

	getServiceZoneID(serviceZone)
	{
		if (typeof serviceZone !== 'string' || serviceZone.length < 2)
		{
			return 'us';
		}
		return serviceZone.substring(0, 2).toLowerCase();
	}

	getSafeExpiresAt(expiresInSeconds, UAID)
	{
		const fallbackSeconds = 300;
		const maxSeconds = 30 * 24 * 60 * 60;
		const parsed = Number(expiresInSeconds);

		if (!Number.isFinite(parsed) || parsed <= 0)
		{
			this.app.updateLog(`Invalid expires_in for UAID ${UAID}: ${this.app.varToString(expiresInSeconds)}. Using fallback ${fallbackSeconds}s`, 0);
			return Date.now() + (fallbackSeconds * 1000);
		}

		const safeSeconds = Math.min(parsed, maxSeconds);
		return Date.now() + (safeSeconds * 1000);
	}

	isAccessTokenExpired(expiresAt)
	{
		const parsed = Number(expiresAt);
		if (!Number.isFinite(parsed))
		{
			return true;
		}

		// Refresh slightly early to avoid edge-case expiry during a request.
		const refreshSkewMs = 30 * 1000;
		return parsed <= (Date.now() + refreshSkewMs);
	}

	async getAccessTokenForUAID(UAID, SecretKey, serviceZone)
	{
		const normalizedUAID = this.normalizeUAID(UAID);
		if (!normalizedUAID)
		{
			this.app.updateLog('Token request rejected: UAID is empty. What you can do: Please enter the full UAID from YoLink and try again. | diag: reason=missing_uaid', 0);
			throw new Error('Invalid UAID');
		}

		if (!this.isValidNormalizedUAID(normalizedUAID))
		{
			this.app.updateLog(`Token request rejected for UAID ${normalizedUAID}. What you can do: Please use the full UAID from YoLink (ua_ + 32 characters). | diag: reason=invalid_uaid_format expected=ua_<32 hex>`, 0);
			throw new Error(`Invalid UAID format: ${normalizedUAID}`);
		}

		if (normalizedUAID !== UAID)
		{
			this.app.updateLog(`Normalized UAID ${UAID} -> ${normalizedUAID}`);
		}

		const requestedServiceZoneID = this.getServiceZoneID(serviceZone);

		// Return the accessToken for the given UAID
		let entry = this.UAIDList.find((item) => item.UAID === normalizedUAID);
		const effectiveServiceZoneID = entry && !serviceZone
			? (entry.serviceZoneID || 'us')
			: requestedServiceZoneID;
		if (entry && this.isAccessTokenExpired(entry.expires_at))
		{
			const refreshPromise = this.tokenRefreshPromises[normalizedUAID] || (async () =>
			{
				this.app.updateLog(`Access token for UAID ${normalizedUAID} has expired, attempting refresh`);

				const currentEntry = this.UAIDList.find((item) => item.UAID === normalizedUAID);
				if (!currentEntry)
				{
					throw new Error(`No token entry found for UAID ${normalizedUAID} during refresh`);
				}

				let refreshZone = currentEntry.serviceZoneID === 'eu' ? 'eu' : effectiveServiceZoneID;

				// Token has expired so get a new one using the refresh token
				let newTokenData = await this.obtainAccessTokenWithRefreshToken(currentEntry.UAID, currentEntry.refresh_token, refreshZone);

				if (newTokenData && newTokenData.state === 'error' && !serviceZone)
				{
					const alternateZone = refreshZone === 'eu' ? 'us' : 'eu';
					this.logTokenFailure(`Refresh token failed for UAID ${normalizedUAID}`, newTokenData);
					this.app.updateLog(`Retrying refresh token for UAID ${normalizedUAID} in alternate zone ${alternateZone}`);
					const retryTokenData = await this.obtainAccessTokenWithRefreshToken(currentEntry.UAID, currentEntry.refresh_token, alternateZone);
					if (retryTokenData && retryTokenData.state !== 'error' && retryTokenData.access_token)
					{
						newTokenData = retryTokenData;
						refreshZone = alternateZone;
						this.app.updateLog(`Refresh token succeeded for UAID ${normalizedUAID} after zone switch to ${alternateZone}`);
					}
				}

				if (!newTokenData || newTokenData.state === 'error' || !newTokenData.access_token)
				{
					this.logTokenFailure(`Failed to refresh access token for UAID ${normalizedUAID}`, newTokenData);
					throw new Error(`Failed to refresh access token for UAID ${normalizedUAID}: ${newTokenData && newTokenData.msg ? newTokenData.msg : 'Unknown error'}`);
				}

				this.app.updateLog(`New token data for UAID ${normalizedUAID}: ${this.app.varToString(newTokenData)}`);

				// Update the entry in the UAIDList
				currentEntry.access_token = newTokenData.access_token;
				currentEntry.refresh_token = newTokenData.refresh_token;
				currentEntry.expires_at = this.getSafeExpiresAt(newTokenData.expires_in, normalizedUAID);
				currentEntry.serviceZoneID = refreshZone;
				this.app.updateLog(`Obtained new access token for UAID ${normalizedUAID}, expires at ${this.formatDateForLog(currentEntry.expires_at)}, ${currentEntry.access_token}`);
				this.app.homey.settings.set('UAIDList', this.UAIDList);
				this.refreshMQTTClientsForUAID(normalizedUAID);
			})();

			if (!this.tokenRefreshPromises[normalizedUAID])
			{
				this.tokenRefreshPromises[normalizedUAID] = refreshPromise;
			}

			try
			{
				await refreshPromise;
			}
			finally
			{
				if (this.tokenRefreshPromises[normalizedUAID] === refreshPromise)
				{
					delete this.tokenRefreshPromises[normalizedUAID];
				}
			}

			entry = this.UAIDList.find((item) => item.UAID === normalizedUAID);
		}
		else if (!entry && SecretKey)
		{
			// No entry found for this UAID, so obtain a new access token using the secret key
			this.app.updateLog(`No token cache entry found for UAID ${normalizedUAID}, requesting a new token`);
			let resolvedServiceZoneID = effectiveServiceZoneID;
			let newTokenData = await this.obtainAccessTokenWithSecret(normalizedUAID, SecretKey, resolvedServiceZoneID);

			if (newTokenData && newTokenData.state === 'error' && !serviceZone)
			{
				const alternateZone = effectiveServiceZoneID === 'eu' ? 'us' : 'eu';
				this.logTokenFailure(`Initial token request failed for UAID ${normalizedUAID}`, newTokenData);
				this.app.updateLog(`Retrying initial token request for UAID ${normalizedUAID} in alternate zone ${alternateZone}`);
				const retryTokenData = await this.obtainAccessTokenWithSecret(normalizedUAID, SecretKey, alternateZone);
				if (retryTokenData && retryTokenData.state !== 'error' && retryTokenData.access_token)
				{
					newTokenData = retryTokenData;
					resolvedServiceZoneID = alternateZone;
					this.app.updateLog(`Initial token request succeeded for UAID ${normalizedUAID} after zone switch to ${alternateZone}`);
				}
			}

			if (newTokenData.state === 'error')
			{
				this.logTokenFailure(`Failed to obtain access token for UAID ${normalizedUAID}`, newTokenData);
				// return null;
				throw new Error(`Failed to obtain access token for UAID ${normalizedUAID}: ${newTokenData.msg}`);
			}
			this.app.updateLog(`New token data for UAID ${normalizedUAID}: ${this.app.varToString(newTokenData)}`);
			this.app.updateLog(`Obtained new access token for UAID ${normalizedUAID}, expires at ${this.formatDateForLog(Date.now() + (newTokenData.expires_in * 1000))}`);

			// Add the new entry to the UAIDList
			entry = {
				UAID: normalizedUAID,
				access_token: newTokenData.access_token,
				refresh_token: newTokenData.refresh_token,
				expires_at: this.getSafeExpiresAt(newTokenData.expires_in, normalizedUAID),
				serviceZoneID: resolvedServiceZoneID,
			};
			this.UAIDList.push(entry);
			this.app.homey.settings.set('UAIDList', this.UAIDList);
		}

		// if (entry && !this.MQTTClient)
		// {
		// 	try
		// 	{
		// 		// Setup the MQTT client
		// 		const brokerConfig = {
		// 			UAID,
		// 			url: 'mqtt://api-eu.yosmart.com',
		// 			port: 8003,
		// 			username: entry.access_token,
		// 			password: '',
		// 		};
		// 		this.MQTTClient = this.setupMQTTClient(brokerConfig);
		// 	}
		// 	catch (err)
		// 	{
		// 		this.app.updateLog(`Failed to setup MQTT client for UAID ${UAID}: ${err.message}`, 0);
		// 	}
		// }

		return entry ? entry.access_token : null;
	}

	refreshMQTTClientsForUAID(UAID)
	{
		if (!this.MQTTList || this.MQTTList.length === 0)
		{
			return;
		}

		const mqttConnections = this.MQTTList.filter((item) => item.UAID === UAID && item.MQTTClient);
		for (const connection of mqttConnections)
		{
			const accessTokenEntry = this.UAIDList.find((item) => item.UAID === UAID);
			if (!accessTokenEntry || !accessTokenEntry.access_token)
			{
				continue;
			}

			const { serviceZoneID } = connection;
			const brokerConfig = {
				UAID,
				url: serviceZoneID === 'eu' ? yoLinkApi.mqttUrl_eu : yoLinkApi.mqttUrl_us,
				port: 8003,
				username: accessTokenEntry.access_token,
				password: '',
				serviceZoneID,
			};

			this.app.updateLog(`Refreshing MQTT client for UAID ${UAID} and serviceZoneID ${serviceZoneID} after token refresh`);
			connection.MQTTClient.end(true);
			this.setupMQTTClient(brokerConfig).then((mqttConnection) =>
			{
				if (!mqttConnection)
				{
					return;
				}

				const index = this.MQTTList.findIndex((item) => item.UAID === UAID && item.serviceZoneID === serviceZoneID);
				if (index >= 0)
				{
					this.MQTTList[index] = mqttConnection;
				}
				else
				{
					this.MQTTList.push(mqttConnection);
				}
			}).catch((error) =>
			{
				this.app.updateLog(`Failed to refresh MQTT client for UAID ${UAID} and serviceZoneID ${serviceZoneID}: ${error.message}`, 0);
			});
		}
	}

	getTokenURL(serviceZoneID)
	{
		if (serviceZoneID === 'eu')
		{
			return `${yoLinkApi.cloudUrl_eu}token`;
		}
		return `${yoLinkApi.cloudUrl_us}token`;
	}

	async request(method = 'GET', url, body = null, headers = {})
	{
		this.app.updateLog(`API request: ${method} ${url} ${this.safeJsonStringify(body)}`);
		const options = {
			method,
			headers: {
				'Content-Type': 'application/json',
				...headers,
			},
			body: body === null ? null : this.safeJsonStringify(body),
		};

		try
		{
			const response = await fetch(url, options);
			const data = await response.json();
			this.app.updateLog(`API response: ${JSON.stringify(data)}`);
			return data;
		}
		catch (error)
		{
			this.logUserFixableFailure(
				'Cloud request failed',
				'Check internet connectivity and retry in a moment.',
				{ method, url, reason: 'request_error', msg: error.message },
			);
			return { state: 'error', msg: error.message };
		}
	}

	// Obtain access token using UAID and secretKey
	async obtainAccessTokenWithSecret(UAID, secretKey, serviceZoneID = 'us')
	{
		const headers = new Headers();
		headers.append('Content-Type', 'application/x-www-form-urlencoded');

		const body = `grant_type=client_credentials&client_id=${encodeURIComponent(UAID)}&client_secret=${encodeURIComponent(secretKey)}`;

		const init = {
			method: 'POST',
			headers,
			body,
		};

		try
		{
			this.app.updateLog(`Token request start | zone=${serviceZoneID} | grant=client_credentials | UAID=${UAID}`);
			const response = await fetch(this.getTokenURL(serviceZoneID), init);
			this.app.updateLog(`Token request response | zone=${serviceZoneID} | grant=client_credentials | status=${response.status}`);
			const mediaType = response.headers.get('content-type');
			let data;
			if (mediaType && mediaType.includes('json'))
			{
				data = await response.json();
			}
			else
			{
				data = await response.text();
			}
			const normalizedData = this.normalizeTokenResponse(data, UAID, serviceZoneID, 'client_credentials');
			if (normalizedData.state === 'error')
			{
				this.logTokenFailure(`Token endpoint rejected client_credentials for UAID ${UAID}`, normalizedData);
			}
			return normalizedData;
		}
		catch (error)
		{
			const errorData = this.normalizeTokenResponse({ state: 'error', msg: error.message }, UAID, serviceZoneID, 'client_credentials');
			this.logTokenFailure(`Failed to obtain access token with secret for UAID ${UAID}`, errorData);
			return errorData;
		}
	}

	async obtainAccessTokenWithRefreshToken(UAID, refreshToken, serviceZoneID = 'us')
	{
		const headers = new Headers();
		headers.append('Content-Type', 'application/x-www-form-urlencoded');

		const body = `grant_type=refresh_token&client_id=${encodeURIComponent(UAID)}&refresh_token=${encodeURIComponent(refreshToken)}`;

		const init = {
			method: 'POST',
			headers,
			body,
		};

		try
		{
			this.app.updateLog(`Token request start | zone=${serviceZoneID} | grant=refresh_token | UAID=${UAID}`);
			const response = await fetch(this.getTokenURL(serviceZoneID), init);
			this.app.updateLog(`Token request response | zone=${serviceZoneID} | grant=refresh_token | status=${response.status}`);
			const mediaType = response.headers.get('content-type');
			let data;
			if (mediaType && mediaType.includes('json'))
			{
				data = await response.json();
			}
			else
			{
				data = await response.text();
			}
			const normalizedData = this.normalizeTokenResponse(data, UAID, serviceZoneID, 'refresh_token');
			if (normalizedData.state === 'error')
			{
				this.logTokenFailure(`Token endpoint rejected refresh_token for UAID ${UAID}`, normalizedData);
			}
			return normalizedData;
		}
		catch (error)
		{
			const errorData = this.normalizeTokenResponse({ state: 'error', msg: error.message }, UAID, serviceZoneID, 'refresh_token');
			this.logTokenFailure(`Failed to obtain access token with refresh token for UAID ${UAID}`, errorData);
			return errorData;
		}
	}

	async getDeviceList(UAID, SecretKey, serviceZone)
	{
		// Get the access token for the UAID. The SecretKey is only needed if there is no valid access token yet
		let accessToken = null;
		try
		{
			accessToken = await this.getAccessTokenForUAID(UAID, SecretKey, serviceZone);
		}
		catch (error)
		{
			this.logUserFixableFailure(
				`Unable to list devices for UAID ${UAID}`,
				'Reconnect the account by re-entering UAID and Secret Key, then try again.',
				{ operation: 'getDeviceList', reason: 'access_token_error', msg: error.message, zone: this.getServiceZoneID(serviceZone) },
			);
			return null;
		}

		if (!accessToken)
		{
			this.logUserFixableFailure(
				`Unable to list devices for UAID ${UAID}`,
				'Reconnect the account by re-entering UAID and Secret Key, then try again.',
				{ operation: 'getDeviceList', reason: 'missing_access_token', zone: this.getServiceZoneID(serviceZone) },
			);
			return null;
		}

		const headers = {
			Authorization: `Bearer ${accessToken}`,
		};

		const body = {
			method: 'Home.getDeviceList',
			time: Math.floor(Date.now() / 1000),
		};

		const serviceZoneID = this.getServiceZoneID(serviceZone);
		const response = await this.request('POST', this.getZoneURL(serviceZoneID), body, headers);
		if (response && response.desc === 'Success')
		{
			if (response && response.data && response.data.devices && response.data.devices.length > 0)
			{
				this.lastDeviceList = response.data.devices;
				return response.data.devices;
			}

			throw new Error(`No devices found for UAID ${UAID}`);
		}
		else if (response)
		{
			this.logUserFixableFailure(
				`Device list request failed for UAID ${UAID}`,
				'Check that the correct region is selected (US/EU) and retry.',
				{ operation: 'getDeviceList', zone: serviceZoneID, desc: response.desc },
			);
			throw new Error(`Failed to obtain device list for UAID ${UAID}: ${response.desc}`);
		}

		throw new Error(`Failed to obtain device list for UAID ${UAID}`);
	}

	getZoneURL(serviceZoneID)
	{
		if (serviceZoneID === 'eu')
		{
			return `${yoLinkApi.cloudUrl_eu}${yoLinkApi.apiUrl}`;
		}
		return `${yoLinkApi.cloudUrl_us}${yoLinkApi.apiUrl}`;
	}

	async getDeviceStatus(UAID, type, deviceId, deviceToken, serviceZone)
	{
		let accessToken = null;
		try
		{
			accessToken = await this.getAccessTokenForUAID(UAID, null, serviceZone);
		}
		catch (error)
		{
			this.logUserFixableFailure(
				`Unable to fetch device status for UAID ${UAID}`,
				'Reconnect the account by re-entering UAID and Secret Key, then try again.',
				{ operation: 'getDeviceStatus', reason: 'access_token_error', msg: error.message, zone: this.getServiceZoneID(serviceZone) },
			);
			return null;
		}

		if (!accessToken)
		{
			this.logUserFixableFailure(
				`Unable to fetch device status for UAID ${UAID}`,
				'Reconnect the account by re-entering UAID and Secret Key, then try again.',
				{ operation: 'getDeviceStatus', reason: 'missing_access_token', zone: this.getServiceZoneID(serviceZone) },
			);
			return null;
		}

		const headers = {
			Authorization: `Bearer ${accessToken}`,
		};

		const body = {
			method: `${type}.getState`,
			time: Math.floor(Date.now() / 1000),
			targetDevice: deviceId,
			token: deviceToken,
			params: {},
		};

		// Get the service zone ID, which is the first two characters of the serviceZone string
		const serviceZoneID = this.getServiceZoneID(serviceZone);
		const url = this.getZoneURL(serviceZoneID);

		const setupKey = `${UAID}_${serviceZoneID}`;
		while (this.mqttSetupPromises[setupKey])
		{
			this.app.updateLog(`Waiting for MQTT client setup to complete for UAID ${UAID} and serviceZoneID ${serviceZoneID}`);
			await this.mqttSetupPromises[setupKey];
		}

		const setupPromise = (async () =>
		{
			const retryKey = `${UAID}_${serviceZoneID}`;
			if (this.mqttRetryTimers && this.mqttRetryTimers[retryKey])
			{
				// A retry timer exists for this UAID/serviceZoneID, so don't try setting up MQTT client now
				this.app.updateLog(`Skipping wait for MQTT client setup for UAID ${UAID} and serviceZoneID ${serviceZoneID} as a retry timer exists`);
				return;
			}

			// Ensure an MQTT client is setup for this UAID and serviceZoneID
			const entry = this.MQTTList.find((item) => (item.UAID === UAID) && (item.serviceZoneID === serviceZoneID));
			if (!entry)
			{
				try
				{
					this.app.updateLog(`MQTT client for UAID ${UAID} and serviceZoneID ${serviceZoneID} not found, setting up now`);

					// Setup the MQTT client
					let mqttURL;
					if (serviceZoneID === 'eu')
					{
						mqttURL = yoLinkApi.mqttUrl_eu;
					}
					else
					{
						mqttURL = yoLinkApi.mqttUrl_us;
					}

					const brokerConfig = {
						UAID,
						url: mqttURL,
						port: 8003,
						username: accessToken,
						password: '',
						serviceZoneID,
					};
					const MQTTConnection = await this.setupMQTTClient(brokerConfig);
					if (MQTTConnection)
					{
						this.MQTTList.push(MQTTConnection);
						this.app.updateLog(`MQTT client setup complete for UAID ${UAID}. Number of MQTT clients: ${this.MQTTList.length}`);
					}
				}
				catch (err)
				{
					this.logUserFixableFailure(
						`Failed to setup MQTT for UAID ${UAID}`,
						'Check that the selected region matches your YoLink account, then retry.',
						{ operation: 'mqtt_setup', zone: serviceZoneID, msg: err.message },
					);
				}
			}
			else
			{
				this.app.updateLog(`MQTT client already setup for UAID ${UAID} and serviceZoneID ${serviceZoneID}`);
			}
		})();

		this.mqttSetupPromises[setupKey] = setupPromise;
		try
		{
			await setupPromise;
		}
		finally
		{
			if (this.mqttSetupPromises[setupKey] === setupPromise)
			{
				delete this.mqttSetupPromises[setupKey];
			}
		}

		return this.request('POST', url, body, headers);
	}

	async controlDevice(UAID, deviceId, deviceToken, serviceZone, command, params = {})
	{
		let accessToken = null;
		try
		{
			accessToken = await this.getAccessTokenForUAID(UAID, null, serviceZone);
		}
		catch (error)
		{
			this.logUserFixableFailure(
				`Unable to control device for UAID ${UAID}`,
				'Reconnect the account by re-entering UAID and Secret Key, then try again.',
				{ operation: 'controlDevice', command, reason: 'access_token_error', msg: error.message, zone: this.getServiceZoneID(serviceZone) },
			);
			return { desc: `Failed to obtain access token for UAID ${UAID}` };
		}

		if (!accessToken)
		{
			this.logUserFixableFailure(
				`Unable to control device for UAID ${UAID}`,
				'Reconnect the account by re-entering UAID and Secret Key, then try again.',
				{ operation: 'controlDevice', command, reason: 'missing_access_token', zone: this.getServiceZoneID(serviceZone) },
			);
			return { desc: `Failed to obtain access token for UAID ${UAID}` };
		}

		const headers = {
			Authorization: `Bearer ${accessToken}`,
		};
		const body = {
			method: command,
			time: Math.floor(Date.now() / 1000),
			targetDevice: deviceId,
			token: deviceToken,
			params,
		};

		// Get the service zone ID, which is the first two characters of the serviceZone string
		const serviceZoneID = this.getServiceZoneID(serviceZone);
		const url = this.getZoneURL(serviceZoneID);
		return this.request('POST', url, body, headers);
	}

	async getHomeInfo(UAID, serviceZone)
	{
		let accessToken = null;
		try
		{
			accessToken = await this.getAccessTokenForUAID(UAID, null, serviceZone);
		}
		catch (error)
		{
			this.logUserFixableFailure(
				`Unable to fetch home info for UAID ${UAID}`,
				'Reconnect the account by re-entering UAID and Secret Key, then try again.',
				{ operation: 'getHomeInfo', reason: 'access_token_error', msg: error.message, zone: this.getServiceZoneID(serviceZone) },
			);
			return { desc: `Failed to obtain access token for UAID ${UAID}` };
		}

		const headers = {
			Authorization: `Bearer ${accessToken}`,
		};

		const body = {
			method: 'Home.getGeneralInfo',
			time: Math.floor(Date.now() / 1000),
		};

		const serviceZoneID = this.getServiceZoneID(serviceZone);
		return this.request('POST', this.getZoneURL(serviceZoneID), body, headers);
	}

	async postMQTTMessage(mqttMessage)
	{
		this.app.updateLog(`postMQTTMessage: ${this.app.varToString(mqttMessage)}`);

		// Find the MQTT client for the UAID/service zone when available.
		let requestedServiceZoneID = null;
		if (typeof mqttMessage.serviceZoneID === 'string' && mqttMessage.serviceZoneID.length >= 2)
		{
			requestedServiceZoneID = mqttMessage.serviceZoneID.substring(0, 2).toLowerCase();
		}
		else if (typeof mqttMessage.serviceZone === 'string' && mqttMessage.serviceZone.length >= 2)
		{
			requestedServiceZoneID = this.getServiceZoneID(mqttMessage.serviceZone);
		}

		const entry = requestedServiceZoneID
			? this.MQTTList.find((item) => item.UAID === mqttMessage.UAID && item.serviceZoneID === requestedServiceZoneID)
			: this.MQTTList.find((item) => item.UAID === mqttMessage.UAID);
		if (entry && entry.MQTTClient)
		{
			// wait for the MQTT client is ready
			await entry.mqttReady;

			// Publish the message to the yl-home/HomeID/deviceId/command topic
			const topic = `yl-home/${entry.homeID}/**/request`;
			entry.MQTTClient.publish(topic, JSON.stringify(mqttMessage.command), { qos: 0 }, (err) =>
			{
				if (err)
				{
					this.app.updateLog(`postMQTTMessage.publish error: ${this.app.varToString(err)}`, 0);
				}
				else
				{
					this.app.updateLog(`postMQTTMessage.publish: published to ${topic}`, 1);
				}
			});
		}
	}

	async setupMQTTClient(brokerConfig, retryCount = 0, maxRetries = 3)
	{
		try
		{
			let readyToken;
			const mqttReady = new Promise((resolve) =>
			{
				readyToken = resolve;
			});

			// Connect to the MQTT server and subscribe to the state change topic
			const homeID = await this.getHomeInfo(brokerConfig.UAID, brokerConfig.serviceZoneID);
			if (!homeID || !homeID.data || !homeID.data.id)
			{
				this.logUserFixableFailure(
					`Unable to establish MQTT for UAID ${brokerConfig.UAID}`,
					'Check account credentials and region (US/EU), then retry.',
					{ operation: 'mqtt_home_info', zone: brokerConfig.serviceZoneID, msg: homeID && homeID.desc ? homeID.desc : (homeID || 'No response') },
				);
				return null;
			}
			const rndID = Math.floor(Math.random() * 100000);
			this.app.updateLog(`setupMQTTClient connect: ${brokerConfig.url}:${brokerConfig.port}, { clientId: HomeyYoLinkApp-${this.app.homeyID}-${rndID}, username: ${brokerConfig.username}, password: ${brokerConfig.password} }`, 1);
			const MQTTClient = mqtt.connect(`${brokerConfig.url}:${brokerConfig.port}`, { clientId: `HomeyYoLinkApp-${this.app.homeyID}-${rndID}`, username: brokerConfig.username, password: brokerConfig.password });
			let connectionFailed = false;
			let hasConnected = false;
			let authRetryScheduled = false;

			MQTTClient.on('connect', () =>
			{
				hasConnected = true;
				this.app.updateLog(`setupMQTTClient.onConnect: connected to ${brokerConfig.url}:${brokerConfig.port} as ${brokerConfig.UAID}`);

				// Subscribe to the yl-home/HomeID/+/report topic to receive device reports
				this.app.updateLog(`setupMQTTClient.onConnect: homeID is ${this.app.varToString(homeID)}`);
				const topic = `yl-home/${homeID.data.id}/+/report`;
				MQTTClient.subscribe(topic, { qos: 0 }, (err) =>
				{
					if (err)
					{
						this.app.updateLog(`setupMQTTClient.subscribe error: ${this.app.varToString(err)}`, 0);
					}
					else
					{
						this.app.updateLog(`setupMQTTClient.subscribe: subscribed to ${topic}`, 1);
					}
				});

				const topicResponse = `yl-home/${homeID.data.id}/+/response`;
				MQTTClient.subscribe(topicResponse, { qos: 0 }, (err) =>
				{
					if (err)
					{
						this.app.updateLog(`setupMQTTClient.subscribe error: ${this.app.varToString(err)}`, 0);
					}
					else
					{
						this.app.updateLog(`setupMQTTClient.subscribe: subscribed to ${topicResponse}`, 1);
					}

					readyToken();
				});
			});

			MQTTClient.on('error', (err) =>
			{
				this.app.updateLog(`setupMQTTClient.onError: ${this.app.varToString(err)} when connecting to ${brokerConfig.url}:${brokerConfig.port}, HomeyYoLinkApp-${this.app.homeyID}-${rndID}, ${brokerConfig.username}, ${brokerConfig.password}`, 0);

				// Stop reconnection attempts for authentication errors
				if (err.code === 'ECONNREFUSED' ||
					err.message.includes('Connection refused') ||
					err.message.includes('Not authorized') ||
					err.message.includes('Authentication failed'))
				{
					this.app.updateLog('Authentication error detected, stopping MQTT client auto-reconnect attempts', 0);

					// If this client previously worked, force a fresh-token reconnect quickly.
					if (hasConnected && !authRetryScheduled)
					{
						authRetryScheduled = true;
						this.app.updateLog(`Scheduling immediate fresh-token MQTT recovery for UAID ${brokerConfig.UAID}`, 1);
						this.scheduleMQTTRetry(brokerConfig, 1, 1, 1000);
					}

					connectionFailed = true;
					MQTTClient.end(true); // Force close the connection
					readyToken();
				}
			});

			MQTTClient.on('close', () =>
			{
				// The MQTT library reconnects on its own after a transient drop (reconnectPeriod), so only
				// forget this client when the close was deliberate: an authentication failure above, or
				// end() having been called (e.g. by refreshMQTTClientsForUAID when the token was refreshed).
				const deliberateClose = connectionFailed || MQTTClient.disconnecting === true;
				if (!deliberateClose)
				{
					this.app.updateLog(`MQTT connection closed for UAID ${brokerConfig.UAID}, waiting for automatic reconnect`);
					return;
				}

				this.app.updateLog(`MQTT connection ended for UAID ${brokerConfig.UAID}`);
				// Only remove the entry that still points at this client so a late close from a replaced client cannot evict its replacement
				this.MQTTList = this.MQTTList.filter((item) => item.MQTTClient !== MQTTClient);
			});

			MQTTClient.on('message', async (topic, message) =>
			{
				// message is in Buffer
				try
				{
					let mqttMessage = '';
					const mqttString = message.toString();
					try
					{
						mqttMessage = JSON.parse(mqttString);
					}
					catch (err)
					{
						mqttMessage = mqttString;
					}

					this.app.updateLog(`MQTTclient.on message: ${topic}, ${this.app.varToString(mqttMessage)}`);

					const topicParts = topic.split('/');
					const topicDeviceId = topicParts.length >= 3 ? topicParts[2] : null;
					const isTopicDeviceWildcard = topicDeviceId === null || topicDeviceId === '+' || topicDeviceId === '#' || topicDeviceId === '*'
						|| topicDeviceId === '**';

					if (mqttMessage && typeof mqttMessage === 'object')
					{
						if (!mqttMessage.deviceId)
						{
							mqttMessage.deviceId = mqttMessage.targetDevice || (mqttMessage.data && mqttMessage.data.deviceId) || (mqttMessage.data && mqttMessage.data.targetDevice);
						}

						if (!mqttMessage.targetDevice)
						{
							mqttMessage.targetDevice = mqttMessage.deviceId || (mqttMessage.data && mqttMessage.data.targetDevice) || (mqttMessage.data && mqttMessage.data.deviceId);
						}

						if (!isTopicDeviceWildcard && topicDeviceId)
						{
							if (!mqttMessage.deviceId)
							{
								mqttMessage.deviceId = topicDeviceId;
							}

							if (!mqttMessage.targetDevice)
							{
								mqttMessage.targetDevice = topicDeviceId;
							}
						}
					}
					let deviceFound = false;

					const drivers = this.app.homey.drivers.getDrivers();
					for (const driver of Object.values(drivers))
					{
						const devices = driver.getDevices();
						for (const device of Object.values(devices))
						{
							if (device.processMQTTMessage)
							{
								if (await device.processMQTTMessage(mqttMessage).catch(device.error))
								{
									deviceFound = true;
									break;
								}
							}
						}
						if (deviceFound)
						{
							break;
						}
					}

					if (!deviceFound)
					{
						const isResponseTopic = topic.endsWith('/response');
						const hasTargetDevice = mqttMessage && typeof mqttMessage === 'object'
							&& (mqttMessage.targetDevice || mqttMessage.deviceId || (mqttMessage.data && (mqttMessage.data.targetDevice || mqttMessage.data.deviceId)));

						const payloadPreview = this.app.varToString(mqttMessage);
						const payloadSummary = payloadPreview.length > 500 ? `${payloadPreview.substring(0, 500)}...` : payloadPreview;

						if (isResponseTopic && !hasTargetDevice)
						{
							this.app.updateLog(`Ignoring MQTT response without target device for topic ${topic} | payload=${payloadSummary}`, 1);
						}
						else
						{
							this.app.updateLog(`No device found to process MQTT message for topic ${topic} | payload=${payloadSummary}`);
						}
					}
				}
				catch (err)
				{
					this.app.updateLog(`MQTT Client error: ${topic}: ${err.message}`, 0);
				}
			});

			// Wait for the MQTT client to be ready
			this.app.updateLog('setupMQTTClient: waiting for MQTT client to be ready');
			await mqttReady;

			// Return null if connection failed
			if (connectionFailed)
			{
				// Schedule retry on any other error if we haven't exceeded max retries
				if (retryCount < maxRetries)
				{
					this.app.updateLog('Scheduling MQTT reconnection attempt due to error...', 1);
					this.scheduleMQTTRetry(brokerConfig, retryCount + 1, maxRetries);
				}

				return null;
			}

			return { UAID: brokerConfig.UAID, homeID: homeID.data.id, serviceZoneID: brokerConfig.serviceZoneID, mqttReady, MQTTClient };
		}
		catch (err)
		{
			this.logUserFixableFailure(
				`MQTT setup failed for UAID ${brokerConfig.UAID}`,
				'Check account credentials, region selection, and network connectivity, then retry.',
				{ operation: 'setupMQTTClient', zone: brokerConfig.serviceZoneID, msg: err.message },
			);
			return null;
		}
	}

	scheduleMQTTRetry(brokerConfig, retryCount, maxRetries, delayOverrideMs = null)
	{
		// Clear any existing retry timer for this UAID/serviceZoneID
		const retryKey = `${brokerConfig.UAID}_${brokerConfig.serviceZoneID}`;
		if (this.mqttRetryTimers && this.mqttRetryTimers[retryKey])
		{
			clearTimeout(this.mqttRetryTimers[retryKey]);
		}

		// Initialize retry timers object if it doesn't exist
		if (!this.mqttRetryTimers)
		{
			this.mqttRetryTimers = {};
		}

		// Calculate retry delay (exponential backoff: 60s, 120s, 240s) unless overridden.
		const retryDelay = (Number.isFinite(delayOverrideMs) && delayOverrideMs >= 0)
			? delayOverrideMs
			: 60000 * (2 ** (retryCount - 1));

		this.mqttRetryTimers[retryKey] = setTimeout(async () =>
		{
			try
			{
				this.app.updateLog(`Attempting MQTT reconnection for UAID ${brokerConfig.UAID} (attempt ${retryCount}/${maxRetries})`);

				// Get a fresh access token
				const newAccessToken = await this.getAccessTokenForUAID(brokerConfig.UAID, null, brokerConfig.serviceZoneID);
				if (!newAccessToken)
				{
					this.logUserFixableFailure(
						`MQTT reconnect aborted for UAID ${brokerConfig.UAID}`,
						'Reconnect the account by re-entering UAID and Secret Key, then retry.',
						{ operation: 'mqtt_retry', reason: 'missing_access_token', zone: brokerConfig.serviceZoneID },
					);
					return;
				}

				// Update the broker config with the new access token
				const newBrokerConfig = {
					...brokerConfig,
					username: newAccessToken,
				};

				// Attempt to setup MQTT client again
				const MQTTConnection = await this.setupMQTTClient(newBrokerConfig, retryCount, maxRetries);
				if (MQTTConnection)
				{
					// Find and update existing entry in MQTTList or add new one
					const existingIndex = this.MQTTList.findIndex((item) => item.UAID === brokerConfig.UAID && item.serviceZoneID === brokerConfig.serviceZoneID);

					if (existingIndex >= 0)
					{
						this.MQTTList[existingIndex] = MQTTConnection;
					}
					else
					{
						this.MQTTList.push(MQTTConnection);
					}

					this.app.updateLog(`MQTT client reconnection successful for UAID ${brokerConfig.UAID}`, 1);
				}
			}
			catch (err)
			{
				this.logUserFixableFailure(
					`MQTT retry attempt failed for UAID ${brokerConfig.UAID}`,
					'Check network and account credentials, then retry.',
					{ operation: 'mqtt_retry', zone: brokerConfig.serviceZoneID, msg: err.message, attempt: `${retryCount}/${maxRetries}` },
				);
			}
			finally
			{
				// Clean up the timer reference
				delete this.mqttRetryTimers[retryKey];
			}
		}, retryDelay);

		this.app.updateLog(`MQTT retry scheduled for UAID ${brokerConfig.UAID} in ${retryDelay / 1000} seconds`, 1);
	}
};
