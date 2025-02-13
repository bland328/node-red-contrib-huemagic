const axios = require('axios');
const dayjs = require('dayjs');
const https = require('https');
const EventSource = require('eventsource');

function API()
{
	// EVENTS
	this.events = {};

	//
	// INITIALIZE
	this.init = function({ config = null })
	{
		const scope = this;

		// GET BRIDGE
		return new Promise(function(resolve, reject)
		{
			if(!config)
			{
				reject("Bridge is not configured!");
				return false;
			}

			// GET BRIDGE INFORMATION
			axios({
				"method": "GET",
				"url": "https://" + config.bridge + "/api/config",
				"headers": { "Content-Type": "application/json; charset=utf-8" },
				"httpsAgent": new https.Agent({ rejectUnauthorized: false }),
			})
			.then(function(response)
			{
				resolve(response.data);
			})
			.catch(function(error)
			{
				reject(error);
			});
		});
	}

	//
	// MAKE A REQUEST
	this.request = function({ config = null, method = 'GET', resource = null, data = null, version = 2 })
	{
		const scope = this;
		return new Promise(function(resolve, reject)
		{
			if(!config)
			{
				reject("Bridge is not configured!");
				return false;
			}

			// BUILD REQUEST OBJECT
			var request = {
				"method": method,
				"url": "https://" + config.bridge,
				"headers": {
					"Content-Type": "application/json; charset=utf-8",
					"hue-application-key": config.key
				},
				"httpsAgent": new https.Agent({ rejectUnauthorized: false }), // Node is somehow not able to parse the official Philips Hue PEM
			};

			// HAS RESOURCE? -> APPEND
			if(resource !== null)
			{
				if(version === 2)
				{
					resource = (resource !== "all") ? "/"+resource : "";
					request['url'] += "/clip/v2/resource" + resource;
				}
				else if(version === 1)
				{
					request['url'] += "/api/" + config.key + resource;
				}
			}

			// HAS DATA? -> INSERT
			if(data !== null) {
				request['data'] = data;
			}

			// RUN REQUEST
			axios(request)
			.then(function(response)
			{
				if(version === 2)
				{
					if(response.data.errors.length > 0)
					{
						reject(response.data.errors);
					}
					else
					{
						resolve(response.data.data);
					}
				}
				else if(version === 1)
				{
					resolve(response.data);
				}
			})
			.catch(function(error)
			{
				reject(error);
			});
		});
	}

	//
	// SUBSCRIBE TO BRIDGE EVENTS
	this.subscribe = function(config, callback)
	{
		const scope = this;
		return new Promise(function(resolve, reject)
		{
			if(!scope.events[config.id])
			{
				var sseURL = "https://" + config.bridge + "/eventstream/clip/v2";

				// INITIALIZE EVENT SOURCE
				scope.events[config.id] = new EventSource(sseURL, {
					headers: { 'hue-application-key': config.key },
					https: { rejectUnauthorized: false },
				});

				// PIPE MESSAGE TO TARGET FUNCTION
				scope.events[config.id].onmessage = function(event)
				{
					if(event && event.type === 'message' && event.data)
					{
						const messages = JSON.parse(event.data);
						for (var i = messages.length - 1; i >= 0; i--)
						{
							const message = messages[i];
							if(message.type === "update")
							{
								callback(message.data);
							}
						}
					}
				};

				// CONNECTED?
				scope.events[config.id].onopen = function()
				{
					resolve(true);
				}

				// ERROR? -> RETRY?
				scope.events[config.id].onerror = function(error)
				{
					console.log("HueMagic:", "Connection to bridge lost. Trying to reconnect again in 30 seconds…", err);
					setTimeout(function(){ scope.subscribe(config, callback); }, 30000);
					resolve(true);
				}
			}
			else
			{
				scope.unsubscribe(config);
				scope.subscribe(config, callback);
			}
		});
	}

	//
	// UNSUBSCRIBE
	this.unsubscribe = function(config)
	{
		if(this.events[config.id] !== null) { this.events[config.id].close(); }
		this.events[config.id] = null;
	}

	//
	// GET FULL/ROOT RESOURCE
	this.fullResource = function(resource, allResources = {})
	{
		const scope = this;
		var fullResource = Object.assign({}, resource);

		if(resource["owner"])
		{
			fullResource = scope.fullResource(allResources[fullResource["owner"]["rid"]], allResources);
		}
		else if(resource["type"] === "device" || resource["type"] === "room" || resource["type"] === "zone" || resource["type"] === "bridge_home")
		{
			// RESOLVE SERVICES
			var allServices = {};

			for (var i = resource["services"].length - 1; i >= 0; i--)
			{
				const targetService = resource["services"][i];
				const targetType = targetService["rtype"];
				const targetID = targetService["rid"];

				if(!allServices[targetType]) { allServices[targetType] = {}; }
				allServices[targetType][targetID] = Object.assign({}, allResources[targetID]);
			}

			// REPLACE SERVICES
			fullResource["services"] = allServices;
		}

		return fullResource;
	}

	//
	// PROCESS RESOURCES
	this.processResources = function(resources)
	{
		const scope = this;

		// SET CURRENT DATE/TIME
		const currentDateTime = dayjs().format();

		// ACTION!
		return new Promise(function(resolve, reject)
		{
			let resourceList = {};
			let processedResources = {
				_groupsOf: {}
			};

			// CREATE ID BASED OBJECT OF ALL RESOURCES
			resources.forEach(function(resource, index)
			{
				// IS BUTTON? -> REMOVE PREVIOUS STATE
				if(resource.type === "button")
				{
					delete resource["button"];
				}

				resourceList[resource.id] = resource;
			});

			// GET FULL RESOURCES OF EACH OBJECT
			resources.forEach(function(resource, index)
			{
				// GET FULL RESOURCE
				let fullResource = scope.fullResource(resource, resourceList);

				// ADD CURRENT DATE/TIME
				fullResource["updated"] = currentDateTime;

				// ALL ALL TYPES BEHIND RESOURCE
				fullResource["types"] = [ fullResource["type"] ];

				// RESOURCE HAS SERVICES?
				if(fullResource["services"])
				{
					let additionalServiceTypes = Object.keys(fullResource["services"]);

					// SET ADDITIONAL TYPES BEHIND RECCOURCE
					fullResource["types"] = fullResource["types"].concat(additionalServiceTypes);
				}

				// RESOURCE HAS GROUPED SERVICES?
				if(fullResource["grouped_services"])
				{
					for (var g = fullResource["grouped_services"].length - 1; g >= 0; g--)
					{
						const groupedService = fullResource["grouped_services"][g];
						const groupedServiceID = groupedService["rid"];

						if(!processedResources["_groupsOf"][groupedServiceID]) { processedResources["_groupsOf"][groupedServiceID] = []; }
						processedResources["_groupsOf"][groupedServiceID].push(fullResource.id);
					}
				}

				// GIVE FULL RESOURCE BACK TO COLLECTION
				processedResources[fullResource.id] = fullResource;
			});

			resolve(processedResources);
		});
	}
}

// EXPORT
module.exports = new API;