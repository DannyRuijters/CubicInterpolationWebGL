let lastMouseX = 0;
let lastMouseY = 0;
let lastCanvas = null;

function handleMouseDown(event) {
    lastCanvas = event.target;
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
}

function handleMouseUp(event) {
    lastCanvas = null;
}

function handleMouseMove(event) {
    if (lastCanvas != null) {
        const newX = event.clientX;
        const newY = event.clientY;
        const deltaX = newX - lastMouseX;
        const deltaY = newY - lastMouseY;
        lastMouseX = newX;
        lastMouseY = newY;

        const canvas = lastCanvas;
        const gl = canvas.gl;
        gl.translateX -= deltaX * gl.zoom / canvas.width;
        gl.translateY += deltaY * gl.zoom / canvas.height;
        const texture = (gl.filterMode == 0) ? gl.rttFramebufferTextureY.texture : gl.myTexture;
        cubicFilter(gl, texture, canvas.width, canvas.height);
        //window.requestAnimFrame(tick);
        event.preventDefault();
    }
}

function handleMouseWheel(event) {
    // cross-browser wheel delta
    event = window.event || event; // old IE support
    const delta = Math.max(-1, Math.min(1, (event.wheelDelta || -event.detail)));
    const canvas = event.target;
    const gl = canvas.gl;
    gl.zoom -= 0.1 * delta;
    if (gl.zoom < 0.001) gl.zoom = 0.001;  //prevent negative or zero zoom
    const texture = (gl.filterMode == 0) ? gl.rttFramebufferTextureY.texture : gl.myTexture;
    cubicFilter(gl, texture, canvas.width, canvas.height);
    event.preventDefault();
    return false;
}

function addMouseEvents(element) {
    if (element.addEventListener) {
        // IE9, Chrome, Safari, Opera
        element.addEventListener("mousewheel", handleMouseWheel, false);
        element.onmousedown = handleMouseDown;
        // Firefox
        element.addEventListener("DOMMouseScroll", handleMouseWheel, false);
    }
    // IE 6/7/8
    else element.attachEvent("onmousewheel", handleMouseWheel);
}

function windowResize() {
    const devicePixelRatio = window.devicePixelRatio || 1;
    const canvasArray = document.getElementsByClassName("gl.cubicinterpolation");
    for (let index = 0; index < canvasArray.length; ++index) {
        const canvas = canvasArray[index];
        // set the size of the drawingBuffer based on the size it's displayed.
        const width = canvas.clientWidth * devicePixelRatio;
        const height = canvas.clientHeight * devicePixelRatio;
        if (width != canvas.width || height != canvas.height) {
            canvas.width = width;
            canvas.height = height;
            const gl = canvas.gl;
            const texture = (gl.filterMode == 0) ? gl.rttFramebufferTextureY.texture : texture;
            cubicFilter(gl, texture, canvas.width, canvas.height);
        }
    }
}

function addEventHandlers(toggleFilterMode) {
    document.onmouseup = handleMouseUp;
    document.onmousemove = handleMouseMove;
    document.addEventListener('keydown', function(event) {
        if (String.fromCharCode(event.which).toLowerCase() == 'f') {
            toggleFilterMode();
        }
    });
    window.addEventListener('resize', windowResize, true);
}
