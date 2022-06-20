const io = require('socket.io-client')
const mediasoup = require('mediasoup-client')
const socket = io('/mediasoup')

const roomName = window.location.pathname.split('/')[2]

socket.on('connection-success', (payload) => {
  console.log('Client:: ', {
      socketId: payload.socketId
   })
   getLocalStream()
})

let device
let rtpCapabilities
let producerTransport
let videoProducer
let audioProducer
let consumerTransports = []
let consumer
let isProducer = false
let consumingTransports = []

// https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerOptions
// https://mediasoup.org/documentation/v3/mediasoup-client/api/#transport-produce
let params = {
  // mediasoup params
  encodings: [
    {
      rid: 'r0',
      maxBitrate: 100000,
      scalabilityMode: 'S1T3',
    },
    {
      rid: 'r1',
      maxBitrate: 300000,
      scalabilityMode: 'S1T3',
    },
    {
      rid: 'r2',
      maxBitrate: 900000,
      scalabilityMode: 'S1T3',
    },
  ],
  // https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerCodecOptions
  codecOptions: {
    videoGoogleStartBitrate: 1000
  }
}

let audioParams
let videoParams = { params }

const goConnect = (producerOrConsumer) => {
  isProducer = producerOrConsumer
  device === undefined ? getRtpCapabilities() : goCreateTransport()
}

const joinRoom = () => {
  socket.emit('joinRoom', { roomName }, (data) => {
    console.log(`Join Room:: Router RTP Capabilities... ${data.rtpCapabilities}`)
    rtpCapabilities = data.rtpCapabilities

    createDevice()
  })
}

const getLocalStream = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true
    })
  
    localVideo.srcObject = stream

    const videoTrack = stream.getVideoTracks()[0]
    videoParams = {
      track: videoTrack,
      ...videoParams
    }
    const audioTrack = stream.getAudioTracks()[0]
    audioParams = {
      track: audioTrack,
      ...audioParams
    }

    joinRoom()
  } catch (err) {
    console.log(err.message)
  }
}

const goConsume = () => {
  goConnect(false)
}

const goCreateTransport = () => {
  isProducer ? createSendTransport() : createRecvTransport()
}

const createDevice = async () => {
  try {
    device = new mediasoup.Device()
    // Get Router RTP Capabilities - this is how the device knows about the allowed media codecs and other settings.
    await device.load({
      routerRtpCapabilities: rtpCapabilities
    })

    // once the device loads, create transport
    // Directly createSendTransport because everyone joining is a producer
    createSendTransport()
  } catch (err) {
    console.log(error)
    if (error.name === 'UnsupportedError') {
      console.warn('browser not supported')
    }
  }
}

const getRtpCapabilities = () => {
  socket.emit('createRoom', (response) => {
    rtpCapabilities = response.rtpCapabilities

    createDevice()
  })
}

// Server informs the client of a new producer just joined
socket.on('new-producer', ({ producerId }) => signalNewConsumerTransport(producerId))

const getProducers = () => {
  socket.emit('getProducers', producerIds => {
    // For every producer, create a consumer (convert producer to consumer)
    producerIds.forEach(signalNewConsumerTransport)
  })
}

const createSendTransport = () => {
  // Every user is a producer
  // Because this is a send transport, we will set consumer false
  socket.emit('createWebRtcTransport', { consumer: false }, ({ params }) => {
    if (params.error) {
      console.log(params.error)
      return
    }

    console.log('createSendTransport:: ', { params })

    producerTransport = device.createSendTransport(params)

    producerTransport.on('connect', async ({ dtlsParameters}, callback, errBack) => {
      try {
        // Signal local DTLS parameters to the server side transport
        await socket.emit('transport-connect', {
          // transportId: producerTransport.id,
          dtlsParameters: dtlsParameters
        })
        // Tell the transport that parameters were transmitted.
        callback()
      } catch (err) {
        errBack(err)
      }
    })

    producerTransport.on('produce', async (params, callback, errBack) => {
      console.log(params)

      try {
        await socket.emit('transport-produce', {
          // transportId: producerTransport.id,
          kind: params.kind,
          rtpParameters: params.rtpParameters,
          appData: params.appData
        }, ({ id, producersExist }) => {
          // Tell the transport that parameters were transmitted and provide it with the
          // server side producer's id.
          callback({ id })
          console.log(`onProducer id: ${id}, producerExists: ${producersExist}`)
          // if producer exists, then get producer id and join that room
          if (producersExist) {
            getProducers()
          }
        })
      } catch (err) {
        errBack(err)
      }
    })
    
    connectSendTransport()
  })
}

const connectSendTransport = async () => {

  videoProducer = await producerTransport.produce(videoParams)
  audioProducer = await producerTransport.produce(audioParams)

  console.log(`connectSendTransport:: video producer: ${videoProducer}, audio producer ${audioProducer}`)
  
  videoProducer.on('trackended', () => {
    console.log('track ended')

    // close video track
  })

  videoProducer.on('transportclose', () => {
    console.log('transport ended')

    // close video track
  })

  audioProducer.on('trackended', () => {
    console.log('track ended')

    // close audio track
  })

  audioProducer.on('transportclose', () => {
    console.log('transport ended')

    // close audio track
  })
}

// createRecvTransport
const signalNewConsumerTransport = async (remoteProducerId) => {
  //check if we are already consuming the remoteProducerId
  if (consumingTransports.includes(remoteProducerId)) return
  consumingTransports.push(remoteProducerId)

  await socket.emit('createWebRtcTransport', { consumer: true }, ({ params }) => {
    if (params.error) {
      console.log(params.error)
      return
    }
    console.log('signalNewConsumerTransport:: ', { params })
    // Bad variable naming
    let consumerTransport
    try {
      consumerTransport = device.createRecvTransport(params)
    } catch (error) {
      // exceptions: 
      // {InvalidStateError} if not loaded
      // {TypeError} if wrong arguments.
      console.log(error)
      return
    }

    consumerTransport.on('connect', async ({ dtlsParameters }, callback, errBack) => {
      try {
        await socket.emit('transport-recv-connect', {
          // transportId: consumerTransport.id,
          dtlsParameters,
          serverConsumerTransportId: params.id
        })

        callback()
      } catch (err) {
        errBack(err)
      }
    })

    // params.id is the server-side consumer id
    connectRecvTransport(consumerTransport, remoteProducerId, params.id)
  })
}

const connectRecvTransport = async (consumerTransport, remoteProducerId, serverConsumerTransportId) => {
  await socket.emit('consume', {
    rtpCapabilities: device.rtpCapabilities,
    remoteProducerId,
    serverConsumerTransportId
  }, async ({ params }) => {
    if (params.error) {
      console.log('Cannot Consume')
      return
    }

    console.log(`connectRecvTransport:: ${params}`)

    const consumer = await consumerTransport.consume({
      id: params.id,
      producerId: params.producerId,
      kind: params.kind,
      rtpParameters: params.rtpParameters
    })

    console.log({ consumerTransport })

    consumerTransports = [
      ...consumerTransports,
      {
        consumerTransport,
        serverConsumerTransportId: params.id,
        producerId: remoteProducerId,
        consumer
      }
    ]

    console.log(`kind: ${params.kind}`)

    const newElem = document.createElement('div')
    newElem.setAttribute('id', `td-${remoteProducerId}`)

    if (params.kind === 'audio') {
      newElem.innerHTML = `<audio id="${remoteProducerId}" autoplay></audio>`
    } else {
      newElem.setAttribute('class', 'remoteVideo')
      newElem.innerHTML = `<video id="${remoteProducerId}" autoplay class="video"></video>`
    }
    
    videoContainer.appendChild(newElem)

    const { track } = consumer

    // remoteVideo.srcObject = new MediaStream([track])
    document.getElementById(remoteProducerId).srcObject = new MediaStream([track])

    socket.emit('consumer-resume', { serverConsumerId: params.serverConsumerId })
  })
}

socket.on('producer-closed', ({ remoteProducerId }) => {
  const producerToClose = consumerTransports.find(transportData => transportData.producerId === remoteProducerId)
  producerToClose.consumerTransport.close()
  producerToClose.consumer.close()

  // remove the consumer from the transport array
  consumerTransports = consumerTransports.filter(transportData => transportData.producerId !== remoteProducerId)

  // remove the video element
  videoContainer.removeChild(document.getElementById(`td-${remoteProducerId}`))
})
