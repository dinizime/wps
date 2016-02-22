//Functions are exported with the same name as the operation
(function() {
	'use strict';

	var jsts = require('jsts');
	var each = require('turf-meta').coordEach;
	var Voronoi = require('voronoi');
	var async = require('async');
	var request = require('request');

	//for orchestration
	var jobs = require('../src/jobs');

	//for verify
	var firstBy = require('thenBy.js'); //multi dimensional sort
	var scc = require("strongly-connected-components"); //Tarja alg for find Cycles
	var utils = require('../src/utils'); //for schema validation
	var flowSchema = require('../resources/jsonSchema/flowSchema.json');

	/* Adapted from old version of Turfjs buffer
	 https://github.com/Turfjs/turf-buffer/blob/master/index.js
	 The function now return all the attributes from the input
	 The function now verify the CRS field in the geoJson
	 
	 Returns an array of Feature;
	*/
	function buffer(geoJson, radius, unit, callback) {
		//convert units
		switch (unit) {
			case 'miles':
				radius = radius / 69.047;
				break;
			case 'feet':
				radius = radius / 364568.0;
				break;
			case 'kilometers':
				radius = radius / 111.12;
				break;
			case 'meters':
				radius = radius / 111120.0;
				break;
			case 'degrees':
				break;
		}

		//Calculates de buffer of a Feature using JSTS library maintaining all attributes
		var bufferOp = function(feature, radius) {
			var reader = new jsts.io.GeoJSONReader();
			var geom = reader.read(JSON.stringify(feature.geometry));

			//Reprojects to 4326
			//If the featue is not in 4326 its required the CRS. 
			//Without CRS is assumed that is 4326 following the GeoJSON specification

			//Buffer in 4326
			var buffered = geom.buffer(radius);
			var parser = new jsts.io.GeoJSONParser();
			buffered = parser.write(buffered);

			feature.geometry = buffered;
			feature.geometry["@type"] = feature.geometry.type;
			return feature;
		};

		var buffered;
		//If is a feature collection pass the Features individualy to the buffer operation
		if (geoJson.type === 'FeatureCollection') {
			buffered = geoJson.features.map(function(f) {
				return bufferOp(f, radius);
			});
		} else {
			buffered = [bufferOp(geoJson, radius)];
		}
		//buffered is an array of results
		var result = {
			buffered: buffered
		};
		return callback(null, result);
	}

	/*
	Function to verify the relation 'Intersects' between a reference geometry and a candidate and filter the candidate geometries accordingly .
	The candidate can be a Feature Collection or Feature
	For a FeatureCollection the features are verified individually
	Return two array of features, Passad and failed
	*/
	function intersects(reference, candidate, callback) {
		var reader = new jsts.io.GeoJSONReader();

		var referenceFeatures;
		if (reference.type === 'FeatureCollection') {
			//collect FeatureCollection into a multifeature
			var geomType = reference.features[0].geometry.type;
			var multiType = 'Multi' + geomType;

			var coordinates;
			coordinates = reference.features.map(function(f) {
				return f.geometry.coordinates;
			});

			referenceFeatures = {
					type: multiType,
					coordinates: coordinates
			};

		} else {
			referenceFeatures = reference.geometry;
		}

		var referenceGeom = reader.read(JSON.stringify(referenceFeatures));

		var filtered;
		var nonfiltered;
		if (candidate.type === 'FeatureCollection') {
			filtered = candidate.features.filter(function(item) {
				var itemGeom = reader.read(JSON.stringify(item.geometry));
				return referenceGeom["intersects"](itemGeom);
			});

			nonfiltered = candidate.features.filter(function(item) {
				return filtered.indexOf(item) === -1;
			});
		} else {
			var candidateGeom = reader.read(JSON.stringify(candidate.geometry));
			if (referenceGeom["intersects"](candidateGeom)) {
				filtered = [candidate];
				nonfiltered = [];
			} else {
				filtered = [];
				nonfiltered = [candidate];
			}
		}
		//passed and failed are arrays of results
		var result = {
			passed: filtered,
			failed: nonfiltered
		};

		return callback(null, result);
	}

	/*
	Count the number of candidate features that intersects reference features
	Create the attribute count inside properties
	Return reference features as an array
	*/
	function aggregatecount(reference, candidate, callback) {
		var referenceFeatures;
		if (reference.type === 'FeatureCollection') {
			referenceFeatures = reference.features;
		} else {
			referenceFeatures = [reference];
		}

		//Convert FeatureCollection to list of Features and the geometry to the centroid
		var candidateFeatures;
		if (candidate.type === 'FeatureCollection') {
			candidateFeatures = candidate.features;
		} else {
			candidateFeatures = [candidate];
		}

		var reader = new jsts.io.GeoJSONReader();

		referenceFeatures.forEach(function(referenceItem) {
			var count = 0,
				i,
				referenceGeom = reader.read(JSON.stringify(referenceItem.geometry));

			for (i = 0; i < candidateFeatures.length; ++i) {
				var candidateGeom = reader.read(JSON.stringify(candidateFeatures[i].geometry));
				if (referenceGeom["intersects"](candidateGeom)) {
					count++;
					candidateFeatures.splice(i--, 1);
				}
			}

			referenceItem.properties.count = count;
		});

		//reference features is an array of results
		var result = {
			aggregate: referenceFeatures
		};
		return callback(null, result);
	}

	/*
	Adapted from Turf Extent to return a callback
	https://github.com/Turfjs/turf-extent
	Uses Turfjs turf-meta coordEach
	*/
	function bboxFn(geoJson, callback) {

		var extent = [Infinity, Infinity, -Infinity, -Infinity];
		each(geoJson, function(coord) {
			if (extent[0] > coord[0]) extent[0] = coord[0];
			if (extent[1] > coord[1]) extent[1] = coord[1];
			if (extent[2] < coord[0]) extent[2] = coord[0];
			if (extent[3] < coord[1]) extent[3] = coord[1];
		});

		//result is an array of results
		var result = {
			bbox: [{
				bbox: extent
			}]
		};
		return callback(null, result);
	}

	/*

	Requires voronoi package
	https://github.com/gorhill/Javascript-Voronoi

	bbox should be in the form [x0,y0,x1,y1];
	geoJson should be a feature collection with points

	Returns a featurecollection of polygons
	*/
	function voronoiFunc(geoJson, bbox, callback) {

		var v = new Voronoi();

		bbox = bbox.bbox;
		var extend = {
			xl: bbox[0],
			xr: bbox[2],
			yt: bbox[1],
			yb: bbox[3]
		}; // xl is x-left, xr is x-right, yt is y-top, and yb is y-bottom 

		var sites = [];

		geoJson.features.forEach(function(item) {
			sites.push({
				x: item.geometry.coordinates[0],
				y: item.geometry.coordinates[1]
			});
		});

		var diagram;
		try {
			diagram = v.compute(sites, extend);
		} catch (error) {
			return callback(new Error('Voronoi failed'));
		}

		var result = [];
		//build a geojson
		diagram.cells.forEach(function(item) {
			var feature = {};
			feature.type = 'Feature';
			feature["@type"] = "Feature";
			feature.geometry = {};
			feature.geometry.type = 'Polygon';
			feature.geometry["@type"] = "Polygon";
			var edges = item.halfedges.map(function(f) {
				return [
					[f.edge.va.x, f.edge.va.y],
					[f.edge.vb.x, f.edge.vb.y]
				];
			});
			if(edges.length > 0){
				feature.geometry.coordinates = [];
				feature.geometry.coordinates.push(edges[0][0]);
				feature.geometry.coordinates.push(edges[0][1]);
				var aux = edges[0][1];
				edges.shift();
				var i;
				while (edges.length > 0) {
					for (i = 0; i < edges.length; i++) {
						if (edges[i][0][0] === aux[0] && edges[i][0][1] === aux[1]) {
							feature.geometry.coordinates.push(edges[i][1]);
							aux = edges[i][1];
							edges.splice(i--, 1);
						} else {
							if (edges[i][1][0] === aux[0] && edges[i][1][1] === aux[1]) {
								feature.geometry.coordinates.push(edges[i][0]);
								aux = edges[i][0];
								edges.splice(i--, 1);
							}
						}
					}
				}
				//extra list enclosing needed
				feature.geometry.coordinates = [feature.geometry.coordinates];
				//re insert the properties

				for (i = 0; i < geoJson.features.length; i++) {
					if (geoJson.features[i].geometry.coordinates[0] === item.site.x && geoJson.features[i].geometry.coordinates[1] === item.site.y) {
						feature.properties = geoJson.features[i].properties;
						feature["@id"] = geoJson.features[i]["@id"];
						feature.id = geoJson.features[i].id;
						geoJson.features.splice(i--, 1);
					}
				}

				result.push(feature);
			}
		});

		//result is an array of features;
		var results = {
			voronoi: result
		};
		return callback(null, results);
	}

	//orchestration engine WPS
	function orchestration(flow, callback, jobID) {
		var partialStatus = {};
		partialStatus.status = "Running";
		partialStatus.orchestrationStatus = [];

		//Pile to update status of the partial executions
		//Queue to ensure the updates in the Job status will occur in order
		var updateQueue = async.queue(function(task, pcb) {
			//task is a empty value
			if (task) {
				jobs.updateJob(jobID, task, pcb);
			} else {
				jobs.updateJob(jobID, partialStatus, pcb);
			}
		}, 1);

		var updatePartialStatus = function(id, status) {
			partialStatus.orchestrationStatus.forEach(function(item) {
				if (item["@id"] === id) {
					item.status = status;
				}
			});
			updateQueue.push(null);
		};
		//flatten subgraphs
		flow.tasks.forEach(function(item,index) {
			if(item.type === 'Subgraph'){
				//fix possibility of duplicate ids
				item.workflow.tasks.forEach(function(task){
					task["@id"] = task["@id"]+"_"+item["@id"];
				});
				item.workflow.sequenceFlows.forEach(function(f){
					f.to = f.to+"_"+item["@id"];
					f.from = f.from+"_"+item["@id"];
					f["@id"] = f["@id"]+"_"+item["@id"];
				});

				for (var i = 0; i < item.workflow.tasks.length; i++) {
					var task = item.workflow.tasks[i];
					//solve incoming
					var connections = [];
					if(task.type === 'Input Parameter'){
						item.workflow.sequenceFlows.forEach(function(f,j){
							if(f.from === task["@id"]){
								connections.push([f.to,f.toPort]);
								item.workflow.sequenceFlows.splice(j--,1);
							}
						});
						flow.sequenceFlows.forEach(function(f){
							if(f.to === item["@id"] && f.toPort === task.name){
								connections.forEach(function(newflow){
									f.to = newflow[0];
									f.toPort = newflow[1];
								});
							}
						});
						item.workflow.tasks.splice(i--,1);
					}
					//solve outgoing
					if(task.type === 'Output Parameter'){
						connections = [];
						item.workflow.sequenceFlows.forEach(function(f,j){
							if(f.to === task["@id"]){
								connections.push([f.from,f.fromPort]);
								item.workflow.sequenceFlows.splice(j--,1);
							}
						});
						flow.sequenceFlows.forEach(function(f){
							if(f.from === item["@id"] && f.fromPort === task.name){
								connections.forEach(function(newflow){
									f.from = newflow[0];
									f.fromPort = newflow[1];
								});
							}
						});
						item.workflow.tasks.splice(i--,1);
					}					
				};
				flow.tasks = flow.tasks.concat(item.workflow.tasks);
				flow.sequenceFlows = flow.sequenceFlows.concat(item.workflow.sequenceFlows);
				//remove subgraph node;
				flow.tasks.splice(index--,1);
			}
		});

		var preparedFlow = {};
		flow.tasks.forEach(function(item) {
			partialStatus.orchestrationStatus.push({
				"@id": item["@id"],
				name: item.name,
				status: "Accepted"
			});

			preparedFlow[item["@id"]] = [];
			if (item.type === 'Literal') {
				preparedFlow[item["@id"]][0] = function(cb) {
					var result = {};
					//literal only have one output
					result[item.outputs[0]] = item.value;
					updatePartialStatus(item["@id"], 'Succeeded');
					return cb(null, result);
				};
			}
			if (item.type === 'WFS') {
				preparedFlow[item["@id"]][0] = function(cb) {
					var result = {};
					//WFS only have one output
					result[item.outputs[0]] = item.url;
					updatePartialStatus(item["@id"], 'Succeeded');
					return cb(null, result);
				};
			}
			if (item.type === 'WPS') {
				preparedFlow[item["@id"]][0] = function(cb, results) {
					updatePartialStatus(item["@id"], 'Running');
					//build input
					var input = {};
					flow.sequenceFlows.filter(function(f) {
						return f.to === item["@id"];
					}).forEach(function(f) {
						input[f.toPort] = results[f.from][f.fromPort];
					});

					async.waterfall([
						//POST to service
						//If fails callback an error
						function(wcb) {
							//executes job
							request({
								url: item.url,
								method: 'POST', 
								headers: {
									'Content-type': "application/ld+json"
								},
								json: input
							}, function(error, response, body) {
								if (!error && response.statusCode == 202 && response.headers.location) {
									return wcb(null, response.headers.location);
								} else {
									return wcb(new Error("failed request"));
								}
							});
						},
						//Verify job
						//If status = Failed callback an error
						//If status != Succeeded retry						
						function(location, wcb) {
							async.retry(100, function(rcb) {
								request({
									url: location,
									method: 'GET',
									headers: {
										'Accept': 'application/ld+json'
									}
								}, function(error, response, body) {
									if (!error && response.statusCode == 200) {
										var status = JSON.parse(body).status;
										if (status === "Succeeded") {
											console.log("Results for " + item.name + " are ready!");
											var resultsUrl = JSON.parse(body).resultsUrl;
											return rcb(null, resultsUrl);
										} else {
											console.log("Results not ready");
											setTimeout(function() {
												return rcb(new Error("Results for " + item.name + " not ready"));
											}, 2000);
										}
									} else {
										setTimeout(function() {
											return rcb(new Error("Error in the Request"));
										}, 2000);
									}
								});
							}, function(err, result) {
								if (err) {
									return wcb(new Error("failed request"));
								} else {
									return wcb(null, result);
								}
							});

						},
						//Get output list
						//Pass as result
						function(location, wcb) {
							request({
								url: location, 
								method: 'GET', 
								headers: {
									'Accept': 'application/ld+json'
								}
							}, function(error, response, body) {
								if (!error && response.statusCode == 200) {
									return wcb(null, JSON.parse(body));
								} else {
									console.log(error);
									return wcb(error);
								}
							});
						}
					], function(err, result) {
						if (err) {
							updatePartialStatus(item["@id"], 'Failed');
							return cb(err);
						}
						delete result["@context"];
						delete result["@type"];
						delete result.jobID;
						updatePartialStatus(item["@id"], 'Succeeded');
						return cb(null, result);
					});

				};
			}
		});
		//set dependencies
		flow.sequenceFlows.forEach(function(item) {
			preparedFlow[item.to].unshift(item.from);
		});
		//executes the orchestration
		async.auto(preparedFlow, function(err, results) {
			if (err) {
				//update job status to failed in case of error
				updateQueue.push({
					status: "Failed"
				});
				return callback(err);
			} else {
				//return result object
				var finalResult = {
					results: [results]
				};
				return callback(null, finalResult);
			}
		});
	}

	function verify(flow, callback) {


		var structuralValidation = function(flow) {
			var errors = {};
			errors.total = 0;
			errors.errors = [];
			var validationFunctions = [];
			//Verify if all tasks have unique ID
			//Verify if all sequenceFlows have unique ID
			var invalidIds = function(flow) {
				var invalidSequenceFlowIds = [];
				var invalidTaskIds = [];

				var countDuplicates = function(a) {
					var counts = {};
					for (var i = 0; i <= a.length; i++) {
						if (counts[a[i]] === undefined) {
							counts[a[i]] = 1;
						} else {
							counts[a[i]]++;
						}
					}
					var result = [];

					for (var key in counts) {
						if (counts[key] > 1) {
							result.push(key);
						}
					}

					return result;
				};

				invalidSequenceFlowIds = countDuplicates(flow.sequenceFlows.map(function(item) {
					return item["@id"];
				}));

				invalidTaskIds = countDuplicates(flow.tasks.map(function(item) {
					return item["@id"];
				}));

				var error = [];

				if (invalidSequenceFlowIds.length !== 0) {
					error.push({
						"@type": "invalidsequenceFlowsIds",
						"message": "Sequence Flows cannot have duplicate Ids",
						"invalidValues": invalidSequenceFlowIds,
						"valueType": "sequenceFlows"
					});
				}

				if (invalidTaskIds.length !== 0) {
					error.push({
						"@type": "invalidTaskIds",
						"message": "Tasks cannot have duplicate Ids",
						"invalidValues": invalidTaskIds,
						"valueType": "tasks"
					});
				}

				if (error.length === 0) {
					return null;
				} else {
					return error;
				}
			};
			validationFunctions.push(invalidIds);


			//Verify if the name of the inputs/outputs within one task are unique
			var invalidIoNames = function(flow) {
				var invalidIo = [];
				var verifyDuplicates = function(a) {
					var counts = {};
					for (var i = 0; i <= a.length; i++) {
						if (counts[a[i]] === undefined) {
							counts[a[i]] = 1;
						} else {
							return true;
						}
					}
					return false;
				};

				flow.tasks.forEach(function(item) {
					if (verifyDuplicates(item.outputs) || verifyDuplicates(item.inputs)) {
						invalidIo.push(item["@id"]);
					}
				});

				if (invalidIo.length === 0) {
					return null;
				} else {
					return [{
						"@type": "invalidIoNames",
						"message": "Input/Outputs cannot have duplicate names",
						"invalidValues": invalidIo,
						"valueType": "tasks"
					}];
				}
			};
			validationFunctions.push(invalidIoNames);

			//Verify if flows connects valid Ids and inputs/outputs (this also forces outputs to be connected to inputs)
			var invalidSequenceFlows = function(flow) {
				var invalid = [];
				var taskIds = flow.tasks.map(function(item) {
					return item["@id"];
				});

				flow.sequenceFlows.forEach(function(item) {
					if (taskIds.indexOf(item.to) === -1 || taskIds.indexOf(item.from) === -1) {
						invalid.push(item["@id"]);
					} else if (flow.tasks[taskIds.indexOf(item.to)].inputs.indexOf(item.toPort) === -1 || flow.tasks[taskIds.indexOf(item.from)].outputs.indexOf(item.fromPort) === -1) {
						invalid.push(item["@id"]);
					}
				});

				if (invalid.length === 0) {
					return null;
				} else {
					return [{
						"@type": "invalidSequenceFlows",
						"message": "Sequence flows with invalid attribute values",
						"invalidValues": invalid,
						"valueType": "sequenceFlows"
					}];
				}
			};

			validationFunctions.push(invalidSequenceFlows);

			//Type checking for literals (compare value with valueType)
			var invalidLiteralType = function(flow) {

				function isJson(str) {
					var o;
					try {
						o = JSON.parse(str);

					} catch (e) {
						return false;
					}

					if (o && typeof o === "object") {
						return true;
					} else {
						return false;
					}
				}
				//loop for every task finding literals
				var literals = flow.tasks.filter(function(task) {
					return task.type === "Literal";
				})

				literals = literals.filter(function(literal) {
					var invalid;
					switch (literal.metadata.outputTypes.literal.type) {
						case "String":
							//FIXME exists invalid string?
							invalid = false;
							break;
						case "Integer":
							if (isNaN(literal.value) || !Number.isInteger(literal.value)) {
								invalid = true;
							} else {
								invalid = false;
							}
						case "Real":
							if (isNaN(literal.value) || typeof literal.value === "string") {
								invalid = true;
							} else {
								invalid = false;
							}
							break;
						case "BBOX":
							var patt = /\[-?\d+,-?\d+,-?\d+,-?\d+\]/;
							if (patt.test(literal.value)) {
								invalid = false;
							} else {
								invalid = true;
							}
							break;
						case "Boolean":
							if (literal.value === "true" || literal.value === "false") {
								invalid = false;
							} else {
								invalid = true;
							}
							break;
						case "JSON Object":
							if (isJson(literal.value)) {
								invalid = false;
							} else {
								invalid = true;
							}
							break;
						default:
							invalid = true;
							break;
					}
					return invalid;

				})

				literals = literals.map(function(literal) {
					return literal["@id"];
				});

				if (literals.length === 0) {
					return null;
				} else {
					return [{
						"@type": "invalidLiteralType",
						"message": "The value provided cannot be parsed in the type valueType",
						"invalidValues": literals,
						"valueType": "tasks"
					}];
				}
			};
			validationFunctions.push(invalidLiteralType);

			//Check for duplicate sequenceFlows
			//duplicates are flow that have the same to,toPort,from,fromPort
			var duplicateSequenceFlow = function(flow) {

				//multidimensional sort based on 4 attributes
				flow.sequenceFlows.sort(
					firstBy("to")
					.thenBy("toPort")
					.thenBy("from")
					.thenBy("fromPort")
				);

				//array that will hold all the invalid sequenceFlows ids
				var dup = [];

				//auxiliary variable for verifying the duplicates
				var current = {
					to: null,
					from: null,
					toPort: null,
					fromPort: null
				};

				//loop in the sequenceFlows and verify if the next one is equal to the current
				//since they are ordered duplicates will be together in the array
				for (var i = 0; i < flow.sequenceFlows.length; i++) {
					if (flow.sequenceFlows[i].to === current.to &&
						flow.sequenceFlows[i].from === current.from &&
						flow.sequenceFlows[i].toPort === current.toPort &&
						flow.sequenceFlows[i].fromPort === current.fromPort) {
						dup.push(flow.sequenceFlows[i]["@id"]);
					} else {
						current = flow.sequenceFlows[i];
					}
				}

				//create error message
				if (dup.length === 0) {
					return null;
				} else {
					return [{
						"@type": "duplicateSequenceFlow",
						"message": "Cannot exist two edges that links the same input/output pair",
						"invalidValues": dup,
						"valueType": "sequenceFlows"
					}];
				}
			};
			validationFunctions.push(duplicateSequenceFlow);

			//Check for cycles based on Tarjan's strongly connected components algorithm
			//returns null if no error or an JSON-LD error message
			var taskCycles = function(flow) {
				//sort sequence flows based on attribute 'from'
				flow.sequenceFlows.sort(function(a, b) {
					return (a.from > b.from) ? 1 : ((b.from > a.from) ? -1 : 0);
				});

				//return only the ids of the tasks
				var taskIndex = flow.tasks.map(function(task) {
					return task["@id"];
				});

				//array of adjacency
				var adjacencyList = [];
				//Variable with simple representation of node connections
				var adjacency = [];

				//auxiliary variable for verifying duplicates
				if(flow.sequenceFlows[0]){
					var current = flow.sequenceFlows[0].from;
				} else {
					return [{
						"@type": "taskCycles",
						"message": "Invalid structure. Cycles could not be verified",
						"invalidValues": null,
						"valueType": "flow",
					}];
				}

				flow.sequenceFlows.forEach(function(edge) {
					if (edge.from !== current) {
						adjacencyList[taskIndex.indexOf(current)] = adjacency;
						adjacency = [];
						current = edge.from;
					}
					adjacency.push(taskIndex.indexOf(edge.to));
				});
				adjacencyList[taskIndex.indexOf(current)] = adjacency;

				for (var i = 0; i < adjacencyList.length; i++) {
					if (adjacencyList[i] === undefined) {
						adjacencyList[i] = [];
					}
					if (adjacencyList[i] === -1) {
						return [{
							"@type": "taskCycles",
							"message": "Invalid structure. Cycles could not be verified",
							"invalidValues": null,
							"valueType": "flow"
						}];
					}
				}

				var cycles;

				try {
					cycles = scc(adjacencyList);
				} catch (e) {
					return [{
						"@type": "taskCycles",
						"message": "Invalid structure. Cycles could not be verified",
						"invalidValues": null,
						"valueType": "flow",
					}];
				}

				if (cycles) {
					cycles = cycles.components.filter(function(comp) {
						return comp.length > 1;
					}).map(function(cycle) {
						var cycleFixed = cycle.map(function(item) {
							return taskIndex[item];
						});
						return cycleFixed;
					});

					if (cycles.length === 0) {
						return null;
					} else {

						var invalidValues = cycles.reduce(function(previousValue, currentValue) {
							return previousValue.concat(currentValue);
						});

						return [{
							"@type": "taskCycles",
							"message": "Cycles are not allowed",
							"invalidValues": invalidValues,
							"valueType": "tasks",
							"cycles": cycles
						}];
					}
				} else {
					return [{
						"@type": "taskCycles",
						"message": "Invalid structure. Cycles could not be verified",
						"invalidValues": [],
						"valueType": "tasks"
					}];
				}

			};
			validationFunctions.push(taskCycles);


			for (var i = 0; i < validationFunctions.length; i++) {
				var func = validationFunctions[i](flow);
				if (func) {
					errors.errors = errors.errors.concat(func);
				}
				console.log("Structural Validation: Executed " + (i + 1) + " of " + validationFunctions.length + " operations");
			}

			errors.total = errors.errors.length;
			return errors;
		}

		var verifyConnections = function(flow) {
			//documentation.inputTypes["name"].optional / multiple
			var errors = {};
			errors.errors = [];
			var multipleConnection = [];
			var missingConnection = [];

			var connections = {};
			flow.sequenceFlows.forEach(function(flow){
				connections[flow.to] = connections[flow.to] || {};
				connections[flow.to][flow.toPort] = connections[flow.to][flow.toPort] + 1 || 1;
			})

			flow.tasks.forEach(function(task) {
				if (task.type === "WPS") {
					var multiple = false;
					var missing = false;
					task.inputs.forEach(function(input) {
						//check docs
						if (task.documentation && task.documentation.inputTypes && task.documentation.inputTypes[input]) {
							//if multiple = false connections < 2
							if (!task.documentation.inputTypes[input].multiple && connections[task["@id"]] && connections[task["@id"]][input] && connections[task["@id"]][input] > 1) {
								multiple = true;
							}
							//if optional = false connections > 0
							if (!task.documentation.inputTypes[input].optional && (!connections[task["@id"]] || !connections[task["@id"]][input] || connections[task["@id"]][input] === 0)) {
								missing = true;
							}
						}
					});

					if (multiple) {
						multipleConnection.push(task["@id"]);
					}
					if (missing) {
						missingConnection.push(task["@id"]);
					}
				}
			});

			if (multipleConnection.length > 0) {
				errors.errors.push({
					"@type": "invalidMultipleConnection",
					"message": "Input with invalid multiple connection",
					"invalidValues": multipleConnection,
					"valueType": "tasks"
				});
			}

			if (missingConnection.length > 0) {
				errors.errors.push({
					"@type": "invalidMissingConnection",
					"message": "Missing connection",
					"invalidValues": missingConnection,
					"valueType": "tasks"
				});
			}

			errors.total = errors.errors.length;
			return errors;
		}

		var staticValidation = function(flow) {
			var errors = {};
			errors.total = 0;
			errors.errors = [];

			//Run thought the graph using Async library
			var preparedFlow = {};

			flow.tasks.forEach(function(item) {
				preparedFlow[item["@id"]] = [];
				if (item.type === 'Literal') {
					preparedFlow[item["@id"]][0] = function(cb) {
						var result = {};
						result[item.outputs[0]] = {
							value: item.value,
							valueType: item.metadata.outputTypes.literal.type
						};
						return cb(null, result);
					};
				}
				if (item.type === 'WFS') {
					preparedFlow[item["@id"]][0] = function(cb) {
						var result = {};
						//WFS only have one output
						result[item.outputs[0]] = item.documentation;
						return cb(null, result);
					};
				}
				if (item.type === 'WPS') {
					preparedFlow[item["@id"]][0] = function(cb, results) {

						var result = {};

						return cb(null, result);

					};
				}
			});

			flow.sequenceFlows.forEach(function(item) {
				preparedFlow[item.to].unshift(item.from);
			});


			async.auto(preparedFlow, function(err, results) {
				if (err) {
					//FIXME error handle
				} else {
					results.total = results.errors.length;
					return results;
				}
			});


		}

		var result = structuralValidation(flow);
		if (result.total > 0) {
			return callback(null, {
				results: [result]
			});
		}

		var result = verifyConnections(flow);
		if (result.total > 0) {
			return callback(null, {
				results: [result]
			});
		}


		// var result = staticValidation(flow);
		// if(result.total > 0) {
		// 	return callback(null, {
		// 		results: [result]
		// 	});			
		// }

		//no errors found
		return callback(null, {
			results: [{
				errors: [],
				total: 0
			}]
		});
	}

	module.exports.buffer = buffer;
	module.exports.intersects = intersects;
	module.exports.aggregatecount = aggregatecount;
	module.exports.bbox = bboxFn;
	module.exports.voronoi = voronoiFunc;
	module.exports.orchestration = orchestration;
	module.exports.verify = verify;

})();