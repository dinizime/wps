/*
  WPS
*/
var async = require('async');

var jobs = require('../src/jobs');
var outputsManagement = require('../src/outputsManagement');
var inputs = require('../src/inputs');
var utils = require('../src/utils');
var spatial = require('../src/functions');

//Generator of unique identifiers for jobs
var uuid = require('node-uuid');

//Geojson validator
var tv4 = utils.tv4;

var settings = require('../config.json');

var schemas = {};
var inputsList = {};
var optionals = {};
var functions = {};
var outputs = {};
var outputList = {};
for (var key in settings.processes) {
  var schema = require(settings.processes[key].schemaLocation);
  schemas[key] = schema;


  inputsList[key] = function (process, body) {
    var aux = {};
    settings.processes[process].inputs.forEach(function (item) {
      aux[item.name] = function (callback) { inputs.getInput(body[item.name], item.mediaType, callback) };
    });

    return aux;

  };

  outputList[key] = function (process, jobID) {
    var outputs = {};
    settings.processes[process].outputs.forEach(function (item) {
      outputs[item.name] = settings.baseURL + 'wps/' + process + '/jobs/' + jobID + '/outputs/' + item.name;
    });
    return outputs;
  };

  outputs[key] = function (process, result, jobID, callback) {
    var outputs = [];
    settings.processes[process].outputs.forEach(function (item) {
      outputs.push(function (cb) { outputsManagement.insertOutput(jobID, item.name, result[item.name], process, cb); });
    });

    async.parallel(outputs, function (err, result) {
      if (err) {
        callback(err);
      }
      callback(null, result);
    });

  };

  functions[key] = function (process, inputs, callback, jobID) {
    var args = settings.processes[process].inputs.map(function(item){
      return inputs[item.name];
    });
    args.push(callback);
    
    //to give jobID to orchestration so it can update the partial status
    if(process === "orchestration"){
      args.push(jobID);
    }
    spatial[process].apply(this, args);
  };
}

function execute(res, process, body, jobID) {
  
  //Queue to ensure the updates in the Job status will occur in order
  var updateQueue = async.queue(function (task, callback) {
    //console.log('Performing task ', task.val2);

    jobs.updateJob(task.val1, task.val2, callback);

  }, 1);
  // When all is processed, drain is called
  updateQueue.drain = function () {
    //console.log('all items have been processed.');
  };

  async.waterfall([
    //Run the requests to the URLs inputs in parallel. In case of failure update status to Failed.
    function (callback) {
      //console.log('1: Request referenced resources')
      async.parallel(inputsList[process](process, body), function (err, result) {
        if (err) {
          callback(err);
        }
        callback(null, result);
      });
    },
      
    //Validate against schema
    function (inputs, callback) {
      //console.log('2: Validating input');
      //Verify optionals         
      settings.processes[process].inputs.forEach(function (item) {
        if (item.optional === true && (inputs[item.name] === undefined || inputs[item.name] === null || inputs[item.name] === '')) {
          inputs[item.name] = item.default;
        }
      });
      //console.log(inputs)
      var inputVal = tv4.validateResult(inputs, schemas[process]);
      //console.log(JSON.stringify(inputVal))
      if (inputVal.valid) {
        callback(null, inputs);
      } else {
        callback('Invalid input');
      }
    },

    function (inputs, callback) {
      //console.log('3: Updates status to Running and executes Process');
      //Update status to Running
      updateQueue.push({ val1: jobID, val2: { status: "Running" } });
      //returns array of features, not a feature collection
      functions[process](process, inputs, callback, jobID);
    },
      
    //insert outputs in Mongodb
    function (result, callback) {
      //console.log('4: Insert results in MongoDB');
      outputs[process](process, result, jobID, callback);
    },
         
    //create outputs list in processes/buffer/jobs/jobID/outputs
    function (result, callback) {
      //console.log('5: Creates output list');
      //update Job status to Succeeded and point to output list
      outputsManagement.createOutputList(jobID, outputList[process](process, jobID), callback);

      updateQueue.push({ val1: jobID, val2: { status: "Succeeded", resultsUrl: settings.baseURL + 'wps/' + process + '/jobs/' + jobID + '/outputs' } });
      // create output list
    }

  ], function (err, result) {
    if (err) {
      console.log(err);
      updateQueue.push({ val1: jobID, val2: { status: "Failed" } });
      return false;
    }
    return true;
  });
}

module.exports.execute = execute;