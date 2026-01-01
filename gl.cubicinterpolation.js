/*-------------------------------------------------------------------------------------------------------------------*\
Copyright (c) 2008-2023, Danny Ruijters. All rights reserved.
http://www.dannyruijters.nl/cubicinterpolation/webgl/

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
following conditions are met:
*  Redistributions of source code must retain the above copyright notice, this list of conditions and the following
   disclaimer.
*  Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following
   disclaimer in the documentation and/or other materials provided with the distribution.
*  Neither the name of the copyright holders nor the names of its contributors may be used to endorse or promote
   products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

The views and conclusions contained in the software and documentation are those of the authors and should not be
interpreted as representing official policies, either expressed or implied.

When using this code in a scientific project, please cite one or all of the following papers:
*  Daniel Ruijters and Philippe Th�venaz, GPU Prefilter for Accurate Cubic B-Spline Interpolation, The Computer
   Journal, vol. 55, no. 1, pp. 15-20, January 2012. http://dannyruijters.nl/docs/cudaPrefilter3.pdf
*  Daniel Ruijters, Bart M. ter Haar Romeny, and Paul Suetens, Efficient GPU-Based Texture Interpolation using Uniform
   B-Splines, Journal of Graphics Tools, vol. 13, no. 4, pp. 61-69, 2008.
\*-------------------------------------------------------------------------------------------------------------------*/

function initGL(canvas) {
    let gl;
    try {
        gl = canvas.getContext("webgl2");
        if (gl == null) { gl = canvas.getContext("experimental-webgl2"); }
        if (gl == null) { gl = canvas.getContext("webgl"); }
        if (gl == null) { gl = canvas.getContext("experimental-webgl"); }
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.disable(gl.DEPTH_TEST);
        gl.zoom = 1.0;
        gl.translateX = 0.0;
        gl.translateY = 0.0;
        gl.rotateAngle = 0.0;
        gl.filterMode = 0;
        canvas.gl = gl;
    } catch (e) {
    }
    if (!gl) {
        alert("Could not initialise WebGL, sorry :-(");
    }
    return gl;
}

function loadShader(gl, str, type) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, str);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        alert(gl.getShaderInfoLog(shader));
        return null;
    }

    return shader;
}

function compileShader(gl, fragmentShader, vertexShader) {
    const shaderProgram = gl.createProgram();
    gl.attachShader(shaderProgram, vertexShader);
    gl.attachShader(shaderProgram, fragmentShader);
    gl.linkProgram(shaderProgram);

    if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
        alert("Could not initialise shaders");
    }

    gl.useProgram(shaderProgram);
    shaderProgram.textureCoordAttribute = gl.getAttribLocation(shaderProgram, "aTextureCoord");
    gl.enableVertexAttribArray(shaderProgram.textureCoordAttribute);
    shaderProgram.samplerUniform = gl.getUniformLocation(shaderProgram, "uSampler");

    return shaderProgram;
}

function initShaders(gl) {
    const shaderPrefilterStr = '\
        varying vec2 vTextureCoord;                                                 \n\
        uniform sampler2D uSampler;                                                 \n\
        uniform vec2 increment;                                                     \n\
                                                                                    \n\
        void main(void) {                                                           \n\
            vec4 w = 1.732176555 * texture2D(uSampler, vTextureCoord);              \n\
            vec2 im = vTextureCoord - increment;                                    \n\
            vec2 ip = vTextureCoord + increment;                                    \n\
            w -= 0.464135309 * (texture2D(uSampler,im)+texture2D(uSampler,ip));     \n\
            im -= increment; ip += increment;                                       \n\
            w += 0.124364681 * (texture2D(uSampler,im)+texture2D(uSampler,ip));     \n\
            im -= increment; ip += increment;                                       \n\
            w -= 0.033323416 * (texture2D(uSampler,im)+texture2D(uSampler,ip));     \n\
            im -= increment; ip += increment;                                       \n\
            w += 0.008928982 * (texture2D(uSampler,im)+texture2D(uSampler,ip));     \n\
            im -= increment; ip += increment;                                       \n\
            w -= 0.002392514 * (texture2D(uSampler,im)+texture2D(uSampler,ip));     \n\
            im -= increment; ip += increment;                                       \n\
            w += 0.000641072 * (texture2D(uSampler,im)+texture2D(uSampler,ip));     \n\
            im -= increment; ip += increment;                                       \n\
            w -= 0.000171775 * (texture2D(uSampler,im)+texture2D(uSampler,ip));     \n\
            gl_FragColor = w;                                                       \n\
        }';
    
    const shaderCubicStr = '\
        varying vec2 vTextureCoord;                                                 \n\
        uniform vec2 nrOfPixels;                                                    \n\
        uniform mat3 matrix;                                                        \n\
        uniform sampler2D uSampler;                                                 \n\
                                                                                    \n\
        void main(void) {                                                           \n\
            // shift the coordinate from [0,1] to [-0.5, nrOfPixels-0.5]            \n\
            //vec2 nrOfPixels = vec2(textureSize2D(uSampler, 0));                   \n\
            vec2 coordTex = (matrix * vec3(vTextureCoord - 0.5, 1)).xy + 0.5;       \n\
            vec2 coord_grid = coordTex * nrOfPixels - 0.5;                          \n\
            vec2 index = floor(coord_grid);                                         \n\
            vec2 fraction = coord_grid - index;                                     \n\
            vec2 one_frac = 1.0 - fraction;                                         \n\
                                                                                    \n\
            vec2 w0 = 1.0/6.0 * one_frac*one_frac*one_frac;                         \n\
            vec2 w1 = 2.0/3.0 - 0.5 * fraction*fraction*(2.0-fraction);             \n\
            vec2 w2 = 2.0/3.0 - 0.5 * one_frac*one_frac*(2.0-one_frac);             \n\
            vec2 w3 = 1.0/6.0 * fraction*fraction*fraction;                         \n\
                                                                                    \n\
            vec2 g0 = w0 + w1;                                                      \n\
            vec2 g1 = w2 + w3;                                                      \n\
            vec2 mult = 1.0 / nrOfPixels;                                           \n\
            //h0 = w1/g0 - 1, move from [-0.5, nrOfVoxels-0.5] to [0,1]             \n\
            vec2 h0 = mult * ((w1 / g0) - 0.5 + index);                             \n\
            //h1 = w3/g1 + 1, move from [-0.5, nrOfVoxels-0.5] to [0,1]             \n\
            vec2 h1 = mult * ((w3 / g1) + 1.5 + index);                             \n\
                                                                                    \n\
            // fetch the four linear interpolations                                 \n\
            vec4 tex00 = texture2D(uSampler, h0);                                   \n\
            vec4 tex10 = texture2D(uSampler, vec2(h1.x, h0.y));                     \n\
            tex00 = mix(tex10, tex00, g0.x);  //weigh along the x-direction         \n\
            vec4 tex01 = texture2D(uSampler, vec2(h0.x, h1.y));                     \n\
            vec4 tex11 = texture2D(uSampler, h1);                                   \n\
            tex01 = mix(tex11, tex01, g0.x);  //weigh along the x-direction         \n\
            gl_FragColor = mix(tex01, tex00, g0.y);  //weigh along the y-direction  \n\
        }';
    
    const shaderSimpleStr = '\
        varying vec2 vTextureCoord;                                                 \n\
        uniform mat3 matrix;                                                        \n\
        uniform sampler2D uSampler;                                                 \n\
        void main(void) {                                                           \n\
            vec2 coordTex = (matrix * vec3(vTextureCoord - 0.5, 1)).xy + 0.5;       \n\
            gl_FragColor = texture2D(uSampler, coordTex);                           \n\
        }';
    
    const shaderVertexStr = '\
        attribute vec2 aTextureCoord;                                               \n\
        varying vec4 vColor;                                                        \n\
        varying vec2 vTextureCoord;                                                 \n\
                                                                                    \n\
        void main(void) {                                                           \n\
            vec2 pos = 2.0 * aTextureCoord - 1.0;                                   \n\
            gl_Position = vec4(pos.x, pos.y, 0.0, 1.0);                             \n\
            vTextureCoord = aTextureCoord;                                          \n\
        }';
    
    const highp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    const precisionTxt = (highp.precision != 0) ?
        'precision highp float;\nprecision highp sampler2D;\n' :
        'precision mediump float;\nprecision mediump sampler2D;\n';
    const fragmentPrefilter = loadShader(gl, precisionTxt+shaderPrefilterStr, gl.FRAGMENT_SHADER);
    const fragmentCubic = loadShader(gl, precisionTxt+shaderCubicStr, gl.FRAGMENT_SHADER);
    const fragmentSimple = loadShader(gl, precisionTxt+shaderSimpleStr, gl.FRAGMENT_SHADER);
    const vertexShader = loadShader(gl, shaderVertexStr, gl.VERTEX_SHADER);

    gl.shaderPrefilter = compileShader(gl, fragmentPrefilter, vertexShader);
    gl.shaderPrefilter.incrementUniform = gl.getUniformLocation(gl.shaderPrefilter, "increment");
    gl.shaderCubic = compileShader(gl, fragmentCubic, vertexShader);
    gl.shaderCubic.nrOfPixelsUniform = gl.getUniformLocation(gl.shaderCubic, "nrOfPixels");
    gl.shaderCubic.matrixUniform = gl.getUniformLocation(gl.shaderCubic, "matrix");
    gl.shaderSimple = compileShader(gl, fragmentSimple, vertexShader);
    gl.shaderSimple.matrixUniform = gl.getUniformLocation(gl.shaderSimple, "matrix");
}

function initTextureCoordBuffer(gl) {
    gl.textureCoordBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.textureCoordBuffer);
    const textureCoords = [1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0];
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(textureCoords), gl.STATIC_DRAW);
    gl.textureCoordBuffer.itemSize = 2;
    gl.textureCoordBuffer.numItems = 4;
}

function initTextureFramebuffer(gl, width, height) {
    const rttFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, rttFramebuffer);

    const rttTexture = gl.createTexture();
    rttTexture.width = width;
    rttTexture.height = height;
    gl.bindTexture(gl.TEXTURE_2D, rttTexture);
    const extFloat = gl.getExtension('OES_texture_float');
    const extFloatBuffer = gl.getExtension('WEBGL_color_buffer_float');
    const extHalfFloat = gl.getExtension('OES_texture_half_float');
    const extHalfFloatBuffer = gl.getExtension('EXT_color_buffer_half_float');
    const texType = (extFloat && extFloatBuffer) ? gl.FLOAT : ((extHalfFloat && extHalfFloatBuffer) ? extHalfFloat.HALF_FLOAT_OES : gl.UNSIGNED_BYTE);
    const internalType = (extFloat && extFloatBuffer) ? gl.RGBA32F : ((extHalfFloat && extHalfFloatBuffer) ? gl.RGBA16F : gl.RGBA);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalType, width, height, 0, gl.RGBA, texType, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const renderbuffer = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);

    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, rttTexture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, renderbuffer);

    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { 'framebuffer': rttFramebuffer, 'texture': rttTexture };
}

function initCanvasGL(canvas) {
    const devicePixelRatio = window.devicePixelRatio || 1;
    // set the size of the drawingBuffer based on the size it's displayed.
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = canvas.clientHeight * devicePixelRatio;
    
    const gl = initGL(canvas);
    initShaders(gl);
    initTextureCoordBuffer(gl);
    return gl;
}

function freeProgram(gl, program) {
    const shaders = gl.getAttachedShaders(program);
    for (let n=0, n_max=shaders.length; n < n_max; n++) {
        gl.deleteShader(shaders[n]);
    }
    gl.deleteProgram(program);
}

function freeTextureFramebuffer(gl, buffer) {
    if (buffer && buffer.framebuffer) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, buffer.framebuffer);
        const renderbuffer = gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME);
        gl.deleteRenderbuffer(renderbuffer);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(buffer.framebuffer);
        buffer.framebuffer = null;
    }
    if (buffer && buffer.texture) {
        gl.deleteTexture(buffer.texture);
        buffer.texture = null;
    }
}

function freeResources(gl) {
    gl.deleteBuffer(gl.textureCoordBuffer);
    freeTextureFramebuffer(gl, gl.rttFramebufferTextureX);
    freeTextureFramebuffer(gl, gl.rttFramebufferTextureY);
    freeProgram(gl, gl.shaderPrefilter);
    freeProgram(gl, gl.shaderCubic);
    freeProgram(gl, gl.shaderSimple);
    
    gl.textureCoordBuffer = null;
    gl.rttFramebufferTextureX = null;
    gl.rttFramebufferTextureY = null;
    gl.shaderPrefilter = null;
    gl.shaderCubic = null;
    gl.shaderSimple = null;
}

function drawTexture(gl, shader) {
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1i(shader.samplerUniform, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.textureCoordBuffer);
    gl.vertexAttribPointer(gl.textureCoordAttribute, gl.textureCoordBuffer.itemSize, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, gl.textureCoordBuffer.numItems);
}

function prefilterX(gl, texture) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, gl.rttFramebufferTextureX.framebuffer);
    gl.viewport(0, 0, texture.width, texture.height);
    gl.useProgram(gl.shaderPrefilter);
    gl.uniform2f(gl.shaderPrefilter.incrementUniform, 1.0 / texture.width, 0.0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);

    drawTexture(gl, gl.shaderPrefilter);
}

function prefilterY(gl, texture) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, gl.rttFramebufferTextureY.framebuffer);
    gl.viewport(0, 0, texture.width, texture.height);
    gl.useProgram(gl.shaderPrefilter);
    gl.uniform2f(gl.shaderPrefilter.incrementUniform, 0.0, 1.0 / texture.height);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, gl.rttFramebufferTextureX.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);

    drawTexture(gl, gl.shaderPrefilter);
}

function cubicFilter(gl, texture, width, height) {
    // Draw final image
    gl.bindFramebuffer(gl.FRAMEBUFFER, gl.buffer);
    gl.viewport(0, 0, width, height);
    const program = (gl.filterMode < 2) ? gl.shaderCubic : gl.shaderSimple;
    gl.useProgram(program);
    if (program == gl.shaderCubic) gl.uniform2f(gl.shaderCubic.nrOfPixelsUniform, texture.width, texture.height);
    const cos = Math.cos(gl.rotateAngle) * gl.zoom;
    const sin = Math.sin(gl.rotateAngle);
    // Calculate aspect ratio correction
    const textureAspect = texture.width / texture.height;
    const canvasAspect = width / height;
    const scaleX = (canvasAspect > textureAspect) ? 1.0 : (canvasAspect /textureAspect);
    const scaleY = (canvasAspect > textureAspect) ? (textureAspect / canvasAspect) : 1.0;
    const matrix = [cos * scaleX, -sin, 0, sin, cos * scaleY, 0, gl.translateX, gl.translateY, 1];
    gl.uniformMatrix3fv(program.matrixUniform, false, matrix);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, (gl.filterMode == 3) ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, (gl.filterMode == 3) ? gl.NEAREST : gl.LINEAR);

    drawTexture(gl, program);
}

function handleLoadedImage(canvas, image, width, height) {
    const gl = canvas.gl;
    if (!gl.myTexture) gl.myTexture = gl.createTexture();
    let texture = gl.myTexture;
    texture.width = width;
    texture.height = height;

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    if (!gl.rttFramebufferTextureY) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.rttFramebufferTextureX = initTextureFramebuffer(gl, texture.width, texture.height);
        gl.rttFramebufferTextureY = initTextureFramebuffer(gl, texture.width, texture.height);
    } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, image);
    }

    prefilterX(gl, texture);
    prefilterY(gl, texture);
    texture = (gl.filterMode == 0) ? gl.rttFramebufferTextureY.texture : texture;
    cubicFilter(gl, texture, canvas.width, canvas.height);
}
