var express = require('express');
var router = express.Router();

//Operations
var wpsOperations = require('../src/WPSOperations');

//Parser for the POST operation
var bodyParser = require('body-parser');
var jsonParser = bodyParser.json({ type: 'application/*+json' });
var cors = require('cors');
var async = require('async');

var jobs = require('../src/jobs');
var outputs = require('../src/outputsManagement');
var inputs = require('../src/inputs');
var utils = require('../src/utils');
var spatial = require('../src/functions');
var wfsOperations = require('../src/WFSOperations');

//Generator of unique identifiers for jobs
var uuid = require('node-uuid');

//Geojson validator
var tv4 = utils.tv4;

var settings = require('../config.json');

var availableProcesses = [];
var inputSchema = {};
for (var key in settings.processes) {
  availableProcesses.push(key);
  var schema = require(settings.processes[key].schemaLocation);
  tv4.addSchema(settings.processes[key].schemaName, schema);
  inputSchema[key] = schema;
}

//opens JSON-LD values
var fs = require("fs");
require.extensions[".jsonld"] = function (m) {
  m.exports = JSON.parse(fs.readFileSync(m.filename, 'utf8'));
};

//CORS middleware
router.use(cors({
  exposedHeaders: "Origin, X-Requested-With, Content-Type, Accept, Link, Location"
}));

//Middleware for verifying available layers
var processesVerify = function (req, res, next) {
  if (availableProcesses.indexOf(req.params.process) != -1) {
    next();
  } else {
    res.status(404).end();
  }
};

//Middleware for content type
var contentVerify = function (req, res, next) {
  //remove aditional information
  var contentType = req.get('Content-Type').split(";")[0].trim();
  if (contentType === settings.processes[req.params.process].contentType) {
    next();
  } else {
    res.status(415).send('Unsupported Media Type');
  }
};

//Middleware for schema validation
var contentValidation = function (req, res, next) {
  var schemaVal = tv4.validateResult(req.body, inputSchema[req.params.process]);
  //console.log(JSON.stringify(schemaVal));
  if (schemaVal.valid) {
    next();
  } else {
    res.status(422).send('Unprocessable Entity');
  }
};

//Middleware for content negotiation
var contentNegotiation = function (req, res, next) {
  var output = settings.processes[req.params.process].outputs.filter(function(item){
    return item.name === req.params.outputID;
  });
  
  if(output.length == 1){
    //formats is an array of strings with the contents it accepts
    if (req.accepts(output[0].formats)) {
      next();
    } else {
      // respond with 406 - Not Acceptable
      res.status(406).send('Not Acceptable');
    }   
  } else {
      // respond with 404
      res.status(404).send('Output not found');    
  }
};

//Middleware for setting Context and JSON-Schema headers (Output)
var describeOutputHeaders = function (req, res, next) {
  var schema = settings.baseURL + "wps/" + req.params.process +"/outputs/" + req.params.outputID + "/schema";
  var context = settings.baseURL + "wps/" + req.params.process +"/outputs/" + req.params.outputID + "/context";
  var metadata = settings.baseURL + "wps/" + req.params.process +"/outputs/" + req.params.outputID + "/capabilities";
  res.links({
    "http://www.w3.org/ns/json-ld#context": context,
    "http://json-schema.org/json-schema": schema,
    "http://www.opengis.net/rest-ows/resourceMetadata": metadata
  });
  next();
};

//Middleware for Capabilities header
var capabilitiesHeader = function (req, res, next) {
  var capabilities = settings.baseURL + "capabilities/";
  res.links({
    "http://www.w3.org/ns/hydra/core#apiDocumentation": capabilities
  });
  next();
};

//Middleware for DescribeProcess Headers
var describeProcessHeaders = function (req, res, next) {
  var schema = settings.baseURL + "wps/" + req.params.process +"/schema";
  var context = settings.baseURL + "wps/" + req.params.process +"/context";
  var metadata = settings.baseURL + "wps/" + req.params.process +"/capabilities";
  res.links({
    "http://www.w3.org/ns/json-ld#context": context,
    "http://json-schema.org/json-schema": schema,
    "http://www.opengis.net/rest-ows/resourceMetadata": metadata
  });
  next();
};

// Generic client
router.get('/wps', capabilitiesHeader, function (req, res, next) {
  res.send('WPS');
});

//GetCapabilities
router.get('/capabilities', capabilitiesHeader,  function (req, res, next) {
  res.header("Content-Type", "application/ld+json");
  res.send(require(settings.capabilities));
});

//DescribeProcess Process Metadata
router.get('/wps/:process/capabilities', processesVerify, function (req, res, next) {
  res.header("Content-Type", "application/ld+json");
  var metadata = require(settings.capabilities);
  var layerMetadata;
  metadata.supportedClass.forEach(function(item){
    if(item["ows:name"] === req.params.process){
      layerMetadata = item;
    }
  });
  res.send(layerMetadata);
});

//DescribeProcess Schema
router.get('/wps/:process/schema', processesVerify, function (req, res, next) {
  res.header("Content-Type", "application/schema+json");
  res.send(require(settings.processes[req.params.process].schemaLocation));
});

//DescribeProcess Context
router.get('/wps/:process/context', processesVerify, function (req, res, next) {
	res.header("Content-Type", "application/ld+json");
	res.send(require(settings.processes[req.params.process].inputContext));
});

router.get('/wps/:process', processesVerify, describeProcessHeaders, function (req, res, next) {
	res.send(req.params.process);
});

router.get('/wps/:process/jobs', processesVerify, describeProcessHeaders, function (req, res, next) {
	res.send(req.params.process+"/jobs");
});

//Execute
router.post('/wps/:process/jobs', processesVerify, jsonParser, contentVerify, contentValidation, function (req, res, next) {
  //Create a job with unique identifier
  var jobID = "job:"+uuid.v1();
      
  //Create a JOB in the database with status Accepted and return the request to the user
  jobs.createJob(res, jobID, req.params.process, cb);

  function cb(val) {
    if (val === null) {
      //Call function according to process
      wpsOperations.execute(res, req.params.process, req.body, jobID);
    } else {
      //does not execute the job since it couldnt save the job information
      console.log(val);
    }
  }
});

//GetStatus
router.get('/wps/:process/jobs/:jobID', processesVerify, function (req, res, next) {
  jobs.getJob(res, req.params.jobID);

});

//Dismiss job
router.delete('/wps/:process/jobs/:jobID', processesVerify, function (req, res, next) {
  jobs.deleteJob(res, req.params.jobID,req.params.process);
});

//GetResults - Collection of results
router.get('/wps/:process/jobs/:jobID/outputs', processesVerify, function (req, res, next) {
  //Only available if job is complete
  //Show the URLs of the available outputs for the job
  outputs.getOutputList(res, req.params.process, req.params.jobID);
});

//GetFeature and GetPropertyValue
//Content negotiation
router.get('/wps/:process/jobs/:jobID/outputs/:outputID', processesVerify, contentNegotiation, describeOutputHeaders, function (req, res, next) {

  var output = settings.processes[req.params.process].outputs.filter(function (item) {
    return item.name === req.params.outputID;
  })[0];

  var formats = {};

  if (output.formats.indexOf('text/html') != -1) {
    formats['text/html'] = function () {
      //render parameter = true
      wfsOperations.getOutput(req, res, true);
    };
  }

  if (output.formats.indexOf('application/ext.geo+json') != -1) {
    formats['application/ext.geo+json'] = function () {
      //render parameter = false
      wfsOperations.getOutput(req, res, false);
    };
  }

  if (output.formats.indexOf('application/ld+json') != -1) {
    formats['application/ld+json'] = function () {
      //render parameter = false
      wfsOperations.getOutput(req, res, false);
    };
  }

  formats['default'] = function () {
    //Format is in the specification but the server cannot handle
    res.status(500).send('The server cannot handle this format');
  };

  res.format(formats); 

});

//getFeatureById and GetPropertyValue 
router.get('/wps/:process/jobs/:jobID/outputs/:outputID/:featureID', processesVerify, contentNegotiation, describeOutputHeaders,  function (req, res, next) {

  var output = settings.processes[req.params.process].outputs.filter(function (item) {
    return item.name === req.params.outputID;
  })[0];

  var formats = {};

  if (output.formats.indexOf('text/html') != -1) {
    formats['text/html'] = function () {
      //render parameter = true
      wfsOperations.getOutputById(req, res, true);
    };
  }

  if (output.formats.indexOf('application/ext.geo+json') != -1) {
    formats['application/ext.geo+json'] = function () {
      //render parameter = false
      wfsOperations.getOutputById(req, res, false);
    };
  }

  if (output.formats.indexOf('application/ld+json') != -1) {
    formats['application/ld+json'] = function () {
      //render parameter = false
      wfsOperations.getOutputById(req, res, false);
    };
  }

  formats['default'] = function () {
    res.status(500).send('The server cannot handle this format');
  };

  res.format(formats);

});

//DescribeOutput Schema
router.get('/wps/:process/outputs/:outputID/schema', processesVerify, function (req, res, next) {

  //FIXME Dynamic generation of Schema
  res.header("Content-Type", "application/schema+json");
  res.send({});
});

//DescribeOutput Context
router.get('/wps/:process/outputs/:outputID/context', processesVerify, function (req, res, next) {
  
  //FIXME Dynamic generation of Context
	res.header("Content-Type", "application/ld+json");
	res.send({});
});

//DescribeOutput Layer Metadata
router.get('/wps/:process/outputs/:outputID/capabilities', processesVerify, function (req, res, next) {
  
  //FIXME Dynamic generation of Metadata
  res.header("Content-Type", "application/ld+json");
  res.send({});
});


module.exports = router;