const { createBot, createProvider, createFlow, addKeyword, addAnswer } = require('@bot-whatsapp/bot');
const QRPortalWeb = require('@bot-whatsapp/portal');
const BaileysProvider = require('@bot-whatsapp/provider/baileys');
const MockAdapter = require('@bot-whatsapp/database/mock');
const https = require('https');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit'); // Importa PDFKit para generación de PDF
const fs = require('fs'); // Importa fs para manejar archivos si es necesario, aunque el PDF será un buffer para el correo

// Estado temporal de usuarios (memoria volátil)
const rutasDeConversacion = new Map();
const TIMEOUT_SESION_MS = 60 * 1000; // 1 minuto de inactividad

// Función para obtener la hora actual en formato HH:MM:SS
const getCurrentTime = () => {
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
};

// Función para formatear el mensaje de console.log
const formatMessageLog = (direction, from, message) => {
    const time = getCurrentTime();
    const directionLabel = direction === 'sent' ? 'BOT ->' : '<- USER';
    // Aseguramos que 'message' sea una cadena
    const messageContent = typeof message === 'string' ? message : JSON.stringify(message);
    return `[${time}] ${directionLabel} ${from}: ${messageContent}`;
};

// Función para obtener la fecha de entrega (sábado o domingo más cercano)
const getNextDeliveryDate = () => {
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0 = Domingo, 1 = Lunes, ..., 6 = Sábado
    let daysToAdd;

    if (dayOfWeek === 0) { // Si es domingo, la entrega es hoy
        daysToAdd = 0;
    } else if (dayOfWeek === 6) { // Si es sábado, la entrega es hoy
        daysToAdd = 0;
    } else if (dayOfWeek < 6) { // Si es de lunes a viernes, la entrega es el próximo sábado
        daysToAdd = 6 - dayOfWeek;
    }

    const nextDeliveryDate = new Date(today);
    nextDeliveryDate.setDate(today.getDate() + daysToAdd);

    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    return nextDeliveryDate.toLocaleDateString('es-ES', options);
};

// Validación de DNI con Apiperu
const validarDni = async (dni, token) => {
    const opciones = {
        hostname: 'apiperu.dev',
        path: '/api/dni',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        }
    };
    return new Promise((resolve, reject) => {
        const req = https.request(opciones, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json);
                } catch (err) {
                    reject(err);
                }
            });
        });
        req.on('error', (err) => reject(err));
        req.write(JSON.stringify({ dni }));
        req.end();
    });
};

// Función para generar la cotización en PDF
const generarCotizacionPDF = async (clienteInfo) => {
    return new Promise((resolve, reject) => {
        // Configuración del documento: A4 vertical con altura ajustada y márgenes pequeños
        const doc = new PDFDocument({
            size: [595.28, 350],
            margin: 25,
            info: {
                Title: 'Cotización VENDOR BOLSAS PLASTICO',
                Author: 'Somos Marketing Perú SAC'
            },
            permissions: {
                printing: 'highResolution',
                modifying: false,
                copying: false,
                annotating: true,
                fillingForms: true,
                contentAccessibility: true,
                documentAssembly: true
            },
            userPassword: clienteInfo.dni // Usamos el DNI del cliente como contraseña
        });

        const buffers = [];

        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
            const pdfBuffer = Buffer.concat(buffers);
            resolve(pdfBuffer);
        });
        doc.on('error', reject);

        // Ancho útil de la página (595.28pt - 2*25pt = 545.28pt)
        const usableWidth = doc.page.width - 2 * doc.page.margins.left;
        const startX = doc.page.margins.left; // 25
        let currentY = 10; // Reducido para subir todo el contenido del encabezado

        // --- Encabezado con puntos de referencia claros ---
        const refY = 10; // Margen superior inicial
        const logoX = startX;
        const logoY = refY;
        const logoWidth = 65;
        const logoHeight = 65;
        doc.image('Logo Somos Marketing Peru SACs.png', logoX, logoY, { width: logoWidth });

        // Nombre de la empresa
        const companyNameX = startX + logoWidth + 10; // 10pt de espacio a la derecha del logo
        const companyNameY = logoY + 8; // 8pt debajo del inicio del logo
        doc.fillColor('#444444')
           .fontSize(12)
           .text('Somos Marketing Perú', companyNameX, companyNameY);
        const companyNameHeight = 12; // Aproximado por fontSize
        const companyNameEndY = companyNameY + companyNameHeight;

        // Dirección
        const addressY = companyNameEndY + 4; // 4pt debajo del nombre
        doc.fontSize(6).text('Jr. Tarapacá 260 - Magdalena del Mar', companyNameX, addressY);
        const addressHeight = 6; // Aproximado por fontSize
        const addressEndY = addressY + addressHeight;

        // Contacto
        const contactY = addressEndY + 4; // 4pt debajo de la dirección
        doc.text('Contacto: 999900396', companyNameX, contactY);
        const contactHeight = 6; // Aproximado por fontSize
        const contactEndY = contactY + contactHeight;

        // Número de Cotización (alineado a la derecha, al nivel del nombre de la empresa)
        const quoteNumberX = startX;
        const quoteNumberY = companyNameY;
        doc.fontSize(8)
           .text('Cotización A-00001', quoteNumberX, quoteNumberY, { align: 'right', width: usableWidth });

        // Línea separadora: 8pt debajo del elemento más bajo del encabezado (logo o contacto)
        const headerBottomY = Math.max(logoY + logoHeight, contactEndY);
        const separatorY = headerBottomY + 8;
        doc.moveTo(startX, separatorY)
           .lineTo(startX + usableWidth, separatorY)
           .stroke();

        // --- Información del Cliente en formato horizontal compacto ---
        currentY = separatorY + 8; // Un poco más de espacio tras la línea
        doc.fontSize(7);
        // Primera línea: CIF/NIF y Cliente
        doc.font('Helvetica-Bold').text('CIF/NIF:', startX, currentY);
        doc.font('Helvetica').text(clienteInfo.dni || 'N/A', startX + 45, currentY);
        doc.font('Helvetica-Bold').text('Cliente:', startX + 180, currentY);
        doc.font('Helvetica').text(clienteInfo.name || 'N/A', startX + 230, currentY);
        currentY += 10;
        // Segunda línea: Teléfono y Dirección
        doc.font('Helvetica-Bold').text('Teléfono:', startX, currentY);
        doc.font('Helvetica').text(clienteInfo.phoneNumber || 'N/A', startX + 45, currentY);
        doc.font('Helvetica-Bold').text('Dirección:', startX + 180, currentY);
        doc.font('Helvetica').text(clienteInfo.address || 'N/A', startX + 230, currentY);
        currentY += 10;
        // Tercera línea: Email
        doc.font('Helvetica-Bold').text('Email:', startX, currentY);
        doc.font('Helvetica').text(clienteInfo.email || 'N/A', startX + 45, currentY);
        currentY += 10;
        // Cuarta línea: Fecha y Ciudad
        doc.font('Helvetica-Bold').text('Fecha:', startX, currentY);
        doc.font('Helvetica').text(new Date().toLocaleDateString('es-ES'), startX + 45, currentY);
        doc.font('Helvetica-Bold').text('Ciudad:', startX + 180, currentY);
        doc.font('Helvetica').text(clienteInfo.city || 'N/A', startX + 230, currentY);
        currentY += 10;
        // Quinta línea: Forma de pago
        doc.font('Helvetica-Bold').text('Forma de pago:', startX, currentY);
        doc.font('Helvetica').text(clienteInfo.paymentMethod ? (clienteInfo.paymentMethod.charAt(0).toUpperCase() + clienteInfo.paymentMethod.slice(1)) : 'N/A', startX + 75, currentY);
        currentY += 12;

        // --- Tabla de Detalles del Pedido ---
        doc.fontSize(7); 
        doc.font('Helvetica-Bold').text('Detalles del Pedido:', startX, currentY);
        currentY = doc.y + 6; 

        const tableHeaderY = currentY;
        // Ajuste de X para vertical A4 (columna de descripción más ancha)
        const col1X = startX, col2X = startX + 30, col3X = startX + 260, col4X = startX + 320, col5X = startX + 390; 
        const colWidthItem = 25, colWidthDesc = 220, colWidthQty = 50, colWidthUnitVal = 60, colWidthTotalVal = 70; 

        doc.font('Helvetica-Bold');
        doc.text('Item', col1X, tableHeaderY, { width: colWidthItem, align: 'center' });
        doc.text('Descripción', col2X, tableHeaderY, { width: colWidthDesc, align: 'left' });
        doc.text('Cant.', col3X, tableHeaderY, { width: colWidthQty, align: 'center' }); 
        doc.text('V. Unit.', col4X, tableHeaderY, { width: colWidthUnitVal, align: 'right' }); 
        doc.text('V. Total', col5X, tableHeaderY, { width: colWidthTotalVal, align: 'right' }); 
        doc.font('Helvetica');

        // Línea del encabezado de la tabla
        doc.moveTo(startX, tableHeaderY + 9) 
           .lineTo(startX + usableWidth, tableHeaderY + 9) 
           .stroke();

        currentY = tableHeaderY + 16; 

        // Filas de la Tabla (para bolsas)
        const valorUnitarioBolsa = 15;
        const subtotalSinRecargoBolsas = clienteInfo.quantity * valorUnitarioBolsa;
        const recargoEnvioCalculado = clienteInfo.quantity < 3 ? 7 : 0; 

        doc.text('1', col1X, currentY, { width: colWidthItem, align: 'center' });
        doc.text(`${clienteInfo.quantity} Paquete(s) de Bolsas de Desecho (100 unidades/paquete)`, col2X, currentY, { width: colWidthDesc, align: 'left' });
        doc.text(clienteInfo.quantity.toString(), col3X, currentY, { width: colWidthQty, align: 'center' });
        doc.text(`S/${valorUnitarioBolsa.toFixed(2)}`, col4X, currentY, { width: colWidthUnitVal, align: 'right' });
        doc.text(`S/${subtotalSinRecargoBolsas.toFixed(2)}`, col5X, currentY, { width: colWidthTotalVal, align: 'right' });
        currentY += 9; 

        if (recargoEnvioCalculado > 0) {
            doc.text('2', col1X, currentY, { width: colWidthItem, align: 'center' });
            doc.text('Recargo por envío (menos de 3 paquetes)', col2X, currentY, { width: colWidthDesc, align: 'left' });
            doc.text('1', col3X, currentY, { width: colWidthQty, align: 'center' });
            doc.text(`S/${recargoEnvioCalculado.toFixed(2)}`, col4X, currentY, { width: colWidthUnitVal, align: 'right' });
            doc.text(`S/${recargoEnvioCalculado.toFixed(2)}`, col5X, currentY, { width: colWidthTotalVal, align: 'right' });
            currentY += 9;
        }

        currentY += 5; 

        // --- Sección de Totales ---
        const igvRate = 0.18;
        const subtotalCalculado = clienteInfo.totalPrice / (1 + igvRate);
        const igvMonto = clienteInfo.totalPrice - subtotalCalculado;

        doc.font('Helvetica-Bold');
        doc.text('Subtotal:', col4X, currentY, { width: colWidthUnitVal, align: 'right' });
        doc.text(`S/${subtotalCalculado.toFixed(2)}`, col5X, currentY, { width: colWidthTotalVal, align: 'right' });
        currentY += 9;

        doc.text('IGV (18%):', col4X, currentY, { width: colWidthUnitVal, align: 'right' });
        doc.text(`S/${igvMonto.toFixed(2)}`, col5X, currentY, { width: colWidthTotalVal, align: 'right' });
        currentY += 9;

        doc.text('TOTAL:', col4X, currentY, { width: colWidthUnitVal, align: 'right' });
        doc.fontSize(9).text(`S/${clienteInfo.totalPrice.toFixed(2)}`, col5X, currentY, { width: colWidthTotalVal, align: 'right' }); 
        doc.font('Helvetica');
        currentY += 7; 

        // --- Observaciones ---
        doc.fontSize(6); 
        doc.font('Helvetica-Bold').text('Observaciones:', startX, currentY + 5); 
        doc.font('Helvetica');
        currentY = doc.y + 5; 
        doc.text('TOMAR EN CUENTA QUE EL SERVIDOR DEL ASISTENTE VIRTUAL TIENE UN COSTO MENSUAL DE 20 SOLES AL MES. NECESITAMOS CREDENCIALES DE FACEBOOK PARA CAMPAÑAS Y FOTOS. EL ITEM 1 INCLUYE 4 DISEÑOS CON DOS REVISIONES POR MES. EL ITEM DOS INCLUYE LA ANALISIS DE MERCADO Y OPTIIMA SEGMENTACIÓN DE MERCADO PREVIO LANZAMIENTO DE LA CAMPAÑA, SE USARA UNO DE LOS DISEÑOS DEL ITEM 1).', startX, currentY, {
            width: usableWidth, 
            align: 'justify'
        });
        currentY = doc.y + 12; // Ajustado a 12 para simular dos saltos de línea (aproximadamente)

        // --- Pie de página ---
        doc.fontSize(6); 
        doc.text('Esta cotización es válida por 30 días a partir de la fecha de emisión.', startX, currentY); 
        currentY = doc.y + 2; // Ajustado para ser más compacto
        doc.text('Atentamente,', startX, currentY);
        currentY = doc.y + 2; // Ajustado para ser más compacto
        doc.text('Equipo Somos Marketing Perú', startX, currentY);

        doc.end(); // Finaliza el documento
    });
};

// Función para enviar correo electrónico
const enviarCorreoConfirmacion = async (destinatarioEmail, nombreCliente, cantidadBolsas, precioTotal, pdfBuffer = null) => {
    const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true, // Usa SSL/TLS
        auth: {
            user: 'contacto@somosmarketingperu.com', // Tu correo de Google Workspace
            pass: 'zatqdjnollcaknyu' // !!! REEMPLAZA CON TU CONTRASEÑA DE APLICACIÓN GENERADA !!!
        }
    });

    const mailOptions = {
        from: 'contacto@somosmarketingperu.com',
        to: destinatarioEmail,
        subject: `¡Pedido Confirmado en VENDOR BOLSAS PLASTICO, ${nombreCliente}! 🎉`,
        html: `
            <h1>Hola ${nombreCliente},</h1>
            <p>¡Gracias por tu pedido de bolsas de desecho en VENDOR BOLSAS PLASTICO!</p>
            <p>Hemos recibido la confirmación de tu pedido:</p>
            <ul>
                <li>Cantidad de paquetes: <strong>${cantidadBolsas}</strong></li>
                <li>Total a pagar: <strong>S/${precioTotal.toFixed(2)}</strong></li>
            </ul>
            <p>Adjunto encontrarás tu cotización en formato PDF.</p>
            <p>En breve nos pondremos en contacto contigo para coordinar los detalles finales de la entrega.</p>
            <p>¡Gracias por elegirnos!</p>
            <p>Atentamente,</p>
            <p>El equipo de VENDOR BOLSAS PLASTICO</p>
            <br>
            <p style="font-style:italic; font-weight:bold; color:#555;">
            Este documento ha sido generado automáticamente por nuestro asistente virtual. De acuerdo con la Ley N° 29733 - Ley de Protección de Datos Personales, informamos que los datos personales recopilados por el bot (DNI, nombre, dirección, etc.) no se guardan en una base de datos persistente. Toda la información personal es de naturaleza efímera y se elimina automáticamente de nuestra memoria en un plazo máximo de 15 minutos después de finalizar la conversación. La única información que persiste es la relacionada con la emisión de la boleta electrónica (a través de la app Emprender SUNAT), la cual es retenida por el vendedor y el cliente para fines legales y de respaldo, garantizando su derecho en caso de cualquier eventualidad.
            </p>
        `,
        attachments: pdfBuffer ? [{
            filename: 'Cotizacion_VendorBolsasPlastico.pdf',
            content: pdfBuffer,
            contentType: 'application/pdf'
        }] : []
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(formatMessageLog('sent', 'BOT', `Correo de confirmación enviado a ${destinatarioEmail}`));
        return true;
    } catch (error) {
        console.error(formatMessageLog('sent', 'BOT', `Error al enviar correo a ${destinatarioEmail}: ${error.message}`));
        return false;
    }
};

// FLUJOS DE CONVERSACIÓN

// Flujo Final para la venta de bolsas
const flujoFinal_Bolsas = addKeyword(['finalizar', 'gracias', 'pedido listo'])
    .addAnswer('¡Listo! 🎉 Tu pedido está en proceso. En breve nos pondremos en contacto contigo para coordinar los detalles finales de la entrega. ¡Gracias por tu compra! 🛒', { capture: false }, async (ctx, { flowDynamic }) => {
        // CONSOLE.LOG PARA MENSAJE RECIBIDO (ACTIVA ESTE FLUJO)
        console.log(formatMessageLog('received', ctx.from, ctx.body));
         // CONSOLE.LOG PARA MENSAJE ENVIADO (MENSAJE FINAL)
        console.log(formatMessageLog('sent', ctx.from, '¡Listo! 🎉 Tu pedido está en proceso. En breve nos pondremos en contacto contigo para coordinar los detalles finales de la entrega. ¡Gracias por tu compra! 🛒'));


        const finalMessages = [
            '📌 **¿Tienes dudas?**',
            'Contáctanos al +51 999 999 999 📱.',
            'Correo: contacto@somosmarketingperu.com 📧.'
        ];
        await flowDynamic(finalMessages);
        // CONSOLE.LOG PARA MENSAJE ENVIADO (INFO CONTACTO)
        console.log(formatMessageLog('sent', ctx.from, finalMessages.join('\n')));
    });

// Flujo para preguntar la cantidad de paquetes
const flujoPreguntaCantidad = addKeyword([])
    .addAnswer('¿Cuántos paquetes de bolsas deseas ordenar? (Cada paquete contiene 100 unidades y cuesta S/15. Pedido mínimo para envío sin recargo es de 3 paquetes).', { capture: true }, async (ctx, { flowDynamic, gotoFlow, fallBack }) => {
        console.log(formatMessageLog('sent', ctx.from, 'Pregunta la cantidad de paquetes de bolsas.'));
        console.log(formatMessageLog('received', ctx.from, ctx.body));

        const cantidadStr = ctx.body.trim();
        const cantidad = parseInt(cantidadStr, 10);
        const precioUnitario = 15;
        const recargoEnvio = 7;
        let totalPrice = 0;
        let message = '';
        let infoRuta = rutasDeConversacion.get(ctx.from) || {};

        if (isNaN(cantidad) || cantidad <= 0) {
            await flowDynamic('❌ Por favor, ingresa un número válido y mayor a cero.');
            console.log(formatMessageLog('sent', ctx.from, '❌ Número inválido.'));
            return fallBack();
        }

        if (cantidad >= 3) {
            totalPrice = cantidad * precioUnitario;
            message = `¡Excelente! Has elegido ${cantidad} paquetes. El total a pagar es de *S/${totalPrice.toFixed(2)}* (sin recargo de envío).`;
        } else {
            totalPrice = (cantidad * precioUnitario) + recargoEnvio;
            message = `Has elegido ${cantidad} paquete(s). El total a pagar es de *S/${totalPrice.toFixed(2)}* (incluye S/7 de recargo por envío a Lima).`;
        }

        infoRuta.quantity = cantidad;
        infoRuta.totalPrice = totalPrice;
        rutasDeConversacion.set(ctx.from, infoRuta);
        console.log(formatMessageLog('debug', ctx.from, `DEBUG: Cantidad y precio total actualizado para ${ctx.from}.`));

        await flowDynamic(message);
        console.log(formatMessageLog('sent', ctx.from, message));

        return gotoFlow(flujoRecopilacionDireccion);
    });

// Flujo para recopilar la dirección de entrega
const flujoRecopilacionDireccion = addKeyword([])
    .addAnswer('Por favor, ingresa tu dirección completa para la entrega (calle, número, distrito, referencia):', { capture: true }, async (ctx, { flowDynamic, gotoFlow }) => {
        console.log(formatMessageLog('sent', ctx.from, 'Solicitando dirección de entrega.'));
        console.log(formatMessageLog('received', ctx.from, ctx.body));

        const infoRuta = rutasDeConversacion.get(ctx.from);
        infoRuta.address = ctx.body;
        rutasDeConversacion.set(ctx.from, infoRuta);
        console.log(formatMessageLog('debug', ctx.from, `DEBUG: Dirección actualizada para ${ctx.from}.`));

        await flowDynamic('¡Dirección recibida! Un momento, por favor.');
        console.log(formatMessageLog('sent', ctx.from, 'Dirección recibida.'));

        return gotoFlow(flujoConfirmarEntrega);
    });

// Flujo para confirmar la entrega y mostrar resumen
const flujoConfirmarEntrega = addKeyword([])
    .addAnswer('Un momento, por favor, estoy procesando tu pedido...', null, async (ctx, { flowDynamic, gotoFlow }) => {
        const infoRuta = rutasDeConversacion.get(ctx.from);
        const estimatedDeliveryDate = getNextDeliveryDate();
        infoRuta.deliveryDate = estimatedDeliveryDate;
        rutasDeConversacion.set(ctx.from, infoRuta);

        const confirmationMessage = `Las entregas se realizan solo los sábados y domingos. Si hiciste tu pedido hoy, la entrega será el próximo *${estimatedDeliveryDate}*.` +
            `\n\n¿Confirmas tu pedido de *${infoRuta.quantity} paquete(s)* de bolsas negras` +
            ` para el día *${estimatedDeliveryDate}*` +
            ` en la dirección *${infoRuta.address}*` +
            ` por un total de *S/${infoRuta.totalPrice.toFixed(2)}* a pagar contraentrega?` +
            `\n\nResponde **Sí** para confirmar o **No** para modificar tu pedido.`;

        await flowDynamic(confirmationMessage);
        console.log(formatMessageLog('sent', ctx.from, confirmationMessage));
    })
    .addAnswer('Responde **Sí** para confirmar o **No** para modificar tu pedido.', { capture: true }, async (ctx, { flowDynamic, gotoFlow, fallBack }) => {
        console.log(formatMessageLog('received', ctx.from, ctx.body));
        const userResponse = ctx.body.trim().toLowerCase();

        if (userResponse === 'sí' || userResponse === 'si') {
            await flowDynamic('¡Excelente! Tu pedido ha sido confirmado. Un asesor se pondrá en contacto contigo para coordinar los detalles finales de la entrega.');
            console.log(formatMessageLog('sent', ctx.from, 'Pedido confirmado.'));
            
            // Guardar confirmación en el estado de conversación
            const infoRuta = rutasDeConversacion.get(ctx.from) || {};
            rutasDeConversacion.set(ctx.from, { ...infoRuta, pedidoConfirmado: true });

            // Redirigir al flujo para pedir el correo electrónico
            return gotoFlow(flujoPedirCorreoElectronico);
        } else if (userResponse === 'no') {
            await flowDynamic('Entendido. Puedes reiniciar el proceso de pedido escribiendo "Hola".');
            console.log(formatMessageLog('sent', ctx.from, 'Pedido no confirmado, reiniciando.'));
            return gotoFlow(flujoBienvenida);
        } else {
            await flowDynamic('❌ No entendí tu respuesta. Por favor, responde **Sí** o **No**.');
            console.log(formatMessageLog('sent', ctx.from, '❌ Respuesta inválida en confirmación de entrega.'));
            return fallBack();
        }
    });

// Flujo de Validación de DNI
const flujoValidacionDni = addKeyword([]) // Se llega aquí por gotoFlow desde Bienvenida
    .addAnswer('Por favor, ingresa tu número de DNI para validar tu identidad:', { capture: true }, async (ctx, { flowDynamic, gotoFlow, fallBack }) => {
        // CONSOLE.LOG PARA MENSAJE ENVIADO (LA PREGUNTA DEL DNI)
        console.log(formatMessageLog('sent', ctx.from, 'Por favor, ingresa tu número de DNI para validar tu identidad:'));

        // CONSOLE.LOG PARA MENSAJE RECIBIDO (LA RESPUESTA DEL USUARIO CON EL DNI)
        console.log(formatMessageLog('received', ctx.from, ctx.body));

        const dni = ctx.body.trim();
        // El token y la llamada a la API se moverán al siguiente flujo

        // Validar formato del DNI
        if (!/^\d{8}$/.test(dni)) {
            const invalidFormatMessage = '⚠️ Formato de DNI inválido. Por favor, ingresa 8 dígitos numéricos.';
            await flowDynamic(invalidFormatMessage);
            // CONSOLE.LOG PARA MENSAJE ENVIADO (ERROR DE FORMATO)
            console.log(formatMessageLog('sent', ctx.from, invalidFormatMessage));
            return fallBack();
        }

        // Guardar el DNI en el estado de conversación para el siguiente paso
        let infoRuta = rutasDeConversacion.get(ctx.from) || {};
        infoRuta.dni = dni;
        rutasDeConversacion.set(ctx.from, infoRuta);

        // Redirigir al nuevo flujo para pedir el código de verificación
        return gotoFlow(flujoPedirCodigoVerificacion);
    });

// Nuevo Flujo para pedir el código de verificación
const flujoPedirCodigoVerificacion = addKeyword([])
    .addAnswer('Por favor, ingresa el *código de verificación* de tu DNI (el último dígito en la parte superior derecha de tu DNI):', { capture: true }, async (ctx, { flowDynamic, gotoFlow, fallBack }) => {
        console.log(formatMessageLog('sent', ctx.from, 'Solicitando código de verificación del DNI.'));
        console.log(formatMessageLog('received', ctx.from, ctx.body));

        const codigoVerificacionUsuario = ctx.body.trim();
        const infoRuta = rutasDeConversacion.get(ctx.from) || {};
        const dniGuardado = infoRuta.dni;
        const token = 'fea232162c6106d5cd603a2c9e91fab25e1dc1ee15b8b720b63bbeb53c839ab7'; // Token de Apiperu

        // Validar formato del código de verificación (debe ser un solo dígito numérico)
        if (!/^\d{1}$/.test(codigoVerificacionUsuario)) {
            await flowDynamic('⚠️ Formato de código de verificación inválido. Por favor, ingresa un *único dígito numérico*.');
            console.log(formatMessageLog('sent', ctx.from, '❌ Código de verificación inválido.'));
            return fallBack();
        }

        try {
            const respuesta = await validarDni(dniGuardado, token);

            if (respuesta && respuesta.success && respuesta.data && respuesta.data.codigo_verificacion) {
                const codigoVerificacionAPI = String(respuesta.data.codigo_verificacion); // Asegurar que sea string para la comparación

                if (codigoVerificacionAPI === codigoVerificacionUsuario) {
                    const nombreCompleto = respuesta.data.nombre_completo;
                    const successMessage = `✅ ¡Gracias! Tu DNI ha sido validado, ${nombreCompleto}.`;
                    await flowDynamic(successMessage);
                    console.log(formatMessageLog('sent', ctx.from, successMessage));

                    rutasDeConversacion.set(ctx.from, { ...infoRuta, validated: true, name: nombreCompleto, verificationCode: codigoVerificacionAPI });

                    return gotoFlow(flujoPreguntaCantidad);
                } else {
                    const validationFailedMessage = '❌ El código de verificación no coincide. Por favor, verifica tu número de DNI y el código e inténtalo de nuevo.';
                    await flowDynamic(validationFailedMessage);
                    console.log(formatMessageLog('sent', ctx.from, '❌ Código de verificación incorrecto.'));
                    return fallBack();
                }
            } else {
                const validationFailedMessage = '❌ Lo siento, no pudimos validar tu DNI o el código de verificación no está disponible. Por favor, verifica el número e inténtalo de nuevo.';
                await flowDynamic(validationFailedMessage);
                console.log(formatMessageLog('sent', ctx.from, '❌ Validación de DNI/código fallida desde la API.'));
                return fallBack();
            }
        } catch (error) {
            console.error('Error al validar DNI con código de verificación:', error);
            const errorMessage = '⚠️ Ocurrió un error técnico al validar tu DNI. Por favor, inténtalo más tarde.';
            await flowDynamic(errorMessage);
            console.log(formatMessageLog('sent', ctx.from, errorMessage));
            return fallBack();
        }
    });

// Nuevo Flujo para pedir el correo electrónico
const flujoPedirCorreoElectronico = addKeyword([])
    .addAnswer('Para enviarte la confirmación de tu pedido y la cotización en PDF, por favor, ingresa tu dirección de correo electrónico:', { capture: true }, async (ctx, { flowDynamic, gotoFlow, fallBack }) => {
        console.log(formatMessageLog('sent', ctx.from, 'Solicitando correo electrónico.'));
        console.log(formatMessageLog('received', ctx.from, ctx.body));

        const emailUsuario = ctx.body.trim();

        // Validación básica de formato de correo electrónico
        const emailRegex = /^[\w.-]+@[\w.-]+\.[a-zA-Z]{2,4}$/;
        if (!emailRegex.test(emailUsuario)) {
            await flowDynamic('❌ Formato de correo electrónico inválido. Por favor, ingresa una dirección de correo válida (ej. tu@ejemplo.com).');
            console.log(formatMessageLog('sent', ctx.from, '❌ Formato de correo inválido.'));
            return fallBack();
        }

        const infoRuta = rutasDeConversacion.get(ctx.from) || {};
        infoRuta.email = emailUsuario;
        // Asegurarse de que phoneNumber esté en infoRuta (ctx.from es el número de teléfono)
        infoRuta.phoneNumber = ctx.from; 
        rutasDeConversacion.set(ctx.from, infoRuta);
        console.log(formatMessageLog('debug', ctx.from, `DEBUG: Correo electrónico actualizado para ${ctx.from}.`));

        // Redirigir al flujo para pedir la ciudad
        return gotoFlow(flujoPedirCiudad);
    });

// Nuevo Flujo para pedir la ciudad
const flujoPedirCiudad = addKeyword([])
    .addAnswer('Por favor, ¿en qué ciudad te encuentras?', { capture: true }, async (ctx, { flowDynamic, gotoFlow }) => {
        console.log(formatMessageLog('sent', ctx.from, 'Solicitando ciudad.'));
        console.log(formatMessageLog('received', ctx.from, ctx.body));

        const ciudadUsuario = ctx.body.trim();
        const infoRuta = rutasDeConversacion.get(ctx.from) || {};
        infoRuta.city = ciudadUsuario;
        rutasDeConversacion.set(ctx.from, infoRuta);
        console.log(formatMessageLog('debug', ctx.from, `DEBUG: Ciudad actualizada para ${ctx.from}.`));

        // Redirigir al flujo para pedir la forma de pago
        return gotoFlow(flujoPedirFormaPago);
    });

// Nuevo Flujo para pedir la forma de pago
const flujoPedirFormaPago = addKeyword([])
    .addAnswer('¿Cuál será tu forma de pago? Responde *Contraentrega* o *Billetera Virtual*.', { capture: true }, async (ctx, { flowDynamic, gotoFlow, fallBack }) => {
        console.log(formatMessageLog('sent', ctx.from, 'Solicitando forma de pago.'));
        console.log(formatMessageLog('received', ctx.from, ctx.body));

        const formaPagoUsuario = ctx.body.trim().toLowerCase();
        let infoRuta = rutasDeConversacion.get(ctx.from) || {};

        if (formaPagoUsuario === 'contraentrega' || formaPagoUsuario === 'billetera virtual') {
            infoRuta.paymentMethod = formaPagoUsuario;
            rutasDeConversacion.set(ctx.from, infoRuta);
            console.log(formatMessageLog('debug', ctx.from, `DEBUG: Forma de pago actualizada para ${ctx.from}.`));

            // Aquí generamos y enviamos el PDF con todos los datos
            if (infoRuta.pedidoConfirmado) {
                await flowDynamic('¡Información completa! Generando y enviando tu cotización...');

                try {
                    const clienteInfoParaPDF = {
                        name: infoRuta.name,
                        dni: infoRuta.dni,
                        phoneNumber: infoRuta.phoneNumber,
                        address: infoRuta.address,
                        email: infoRuta.email,
                        quantity: infoRuta.quantity,
                        totalPrice: infoRuta.totalPrice,
                        city: infoRuta.city, // Añadido
                        paymentMethod: infoRuta.paymentMethod // Añadido
                    };

                    const pdfBuffer = await generarCotizacionPDF(clienteInfoParaPDF);
                    await enviarCorreoConfirmacion(infoRuta.email, infoRuta.name, infoRuta.quantity, infoRuta.totalPrice, pdfBuffer);
                    
                    await flowDynamic('🎉 ¡Pedido confirmado, correo y cotización adjunta enviados! Gracias por tu compra.');
                    return gotoFlow(flujoFinal_Bolsas);
                } catch (pdfError) {
                    console.error(formatMessageLog('error', 'BOT -> EXTERNAL', `Error al generar o adjuntar PDF para ${infoRuta.email}: ${pdfError.message}`));
                    await flowDynamic('⚠️ Hubo un problema al generar tu cotización en PDF, pero tu pedido ha sido confirmado. Nos pondremos en contacto contigo pronto.');
                    // Intentar enviar el correo sin PDF si hay un error en la generación del PDF
                    await enviarCorreoConfirmacion(infoRuta.email, infoRuta.name, infoRuta.quantity, infoRuta.totalPrice);
                    return gotoFlow(flujoFinal_Bolsas);
                }
            } else {
                await flowDynamic('Parece que hubo un problema con la confirmación de tu pedido. Por favor, intenta de nuevo escribiendo "Hola".');
                return gotoFlow(flujoBienvenida);
            }
        } else {
            await flowDynamic('❌ Opción inválida. Por favor, responde *Contraentrega* o *Billetera Virtual*.');
            console.log(formatMessageLog('sent', ctx.from, '❌ Forma de pago inválida.'));
            return fallBack();
        }
    });

// Flujo para la pregunta de contratar servicios (adaptado para bolsas)
const flujoContratarServicios_Bolsas = addKeyword([])
    .addAnswer(
        '🚀 ¿Deseas realizar tu pedido de bolsas de desecho de forma rápida y segura con nosotros? Responde **Sí** para continuar o **No** si no deseas ordenar ahora. (Tiempo de espera: 60 segundos)',
        { idle: 60000, capture: true },
        async (ctx, { flowDynamic, gotoFlow, fallBack }) => {
            console.log(formatMessageLog('sent', ctx.from, 'Pregunta si desea realizar pedido de bolsas (después de pausa).'));
            console.log(formatMessageLog('received', ctx.from, ctx.body));

            const userResponse = ctx.body ? ctx.body.trim().toLowerCase() : '';

            if (ctx.idle) {
                await flowDynamic(`⌛ ¡Parece que no recibimos tu respuesta! Si cambias de opinión, ¡siempre puedes escribir "Hola" para regresar y hacer tu pedido!`);
                return gotoFlow(flujoFinal_Bolsas);
            } else if (userResponse === 'sí' || userResponse === 'si') {
                return gotoFlow(flujoValidacionDni);
            } else if (userResponse === 'no') {
                await flowDynamic('Entendido. No hay problema. ¡Gracias por tu tiempo!');
                return gotoFlow(flujoFinal_Bolsas);
            } else {
                return fallBack('❌ No entendí tu respuesta. Por favor, responde **Sí** o **No**.');
            }
        }
    );

// Flujo Bienvenida
const flujoBienvenida = addKeyword(['HOLA', 'OLA', 'BUENAS', 'menu', 'inicio', 'm'], { sensitive: false })
    .addAction(async (ctx, { flowDynamic, gotoFlow }) => {
        // CONSOLE.LOG PARA MENSAJE RECIBIDO (ACTIVA ESTE FLUJO)
        console.log(formatMessageLog('received', ctx.from, ctx.body));

        // CONSOLE.LOG PARA DEBUG: Ver el estado actual de rutasDeConversacion
        console.log('DEBUG: Estado actual de rutasDeConversacion al iniciar el flujoBienvenida:', Array.from(rutasDeConversacion.entries()));


        const nroTelefonoUsuario = ctx.from;
        const horaActual = Date.now();
        let infoRuta = rutasDeConversacion.get(nroTelefonoUsuario) || { validated: false };

        //Actualiza flujo anterior y la ultima interaccion
        const flujoActual = infoRuta.flujoActual || null;
        infoRuta.flujoAnterior = flujoActual;
        infoRuta.flujoActual = 'flujoBienvenida';

        // Actualizar última interacción
        infoRuta.lastInteraction = horaActual;

        //Se actualiza con la informacion actual
        rutasDeConversacion.set(nroTelefonoUsuario, infoRuta);

        const welcomeMessages = [
            '👋 ¡Hola! Te saluda tu **Asesor de Ventas** especializado en **Bolsas de Desecho** 🗑️✨.',
            'Ofrecemos paquetes de 100 unidades de bolsas negras (60x150cm) a solo *S/15* cada uno.',
            '',
            '📦 **CONDICIONES DE VENTA Y ENTREGA:**',
            '✅ Las entregas se realizan únicamente los **sábados y domingos**.',
            '✅ Si solo deseas *un paquete*, se aplicará un recargo de *S/7* por envío a Lima.',
            '✅ Para pedidos de *3 paquetes o más*, el envío es **sin recargo**.',
            '',
            '¡Simplifica tu compra y recibe tus bolsas en casa! 🚚',
        ];

        // Mensaje de bienvenida con beneficios
        await flowDynamic(welcomeMessages);
        // CONSOLE.LOG PARA MENSAJE ENVIADO
        console.log(formatMessageLog('sent', ctx.from, welcomeMessages.join('\n'))); // Unimos para un log legible

        // NOTA: Ya no redirigimos a flujoValidacionDni aquí.
        // La lógica para esperar la respuesta "Sí" y redirigir va en el siguiente addAnswer.
    })
    .addAnswer('Por favor, revisa nuestros *Términos y Condiciones (TyC)* adjuntos para continuar con el servicio. Una vez que los hayas leído, por favor, responde **Sí** a la siguiente pregunta si estás de acuerdo.', {
        //media: '/home/user/CB_MiroQR_INFO_V1/TyC Canales Digitales (set 2024) VF.pdf'
    }, async (ctx, { flowDynamic }) => {
        // CONSOLE.LOG PARA MENSAJE ENVIADO (EL PDF Y LA INSTRUCCIÓN)
        console.log(formatMessageLog('sent', ctx.from, 'Por favor, revisa nuestros *Términos y Condiciones (TyC)* adjuntos para continuar con el servicio. Una vez que los hayas leído, por favor, responde **Sí** a la siguiente pregunta si estás de acuerdo. (Adjunto: TyC Canales Digitales (set 2024) VF.pdf)'));
    })
    .addAnswer('📌 **¿Estás de acuerdo con el servicio?** Responde **Sí** para continuar 🙌.', { capture: true }, async (ctx, { flowDynamic, gotoFlow, fallBack }) => {
        // CONSOLE.LOG PARA MENSAJE ENVIADO (LA PREGUNTA DEL ACUERDO)
        console.log(formatMessageLog('sent', ctx.from, '📌 **¿Estás de acuerdo con el servicio?** Responde **Sí** para continuar 🙌.'));

        // CONSOLE.LOG PARA MENSAJE RECIBIDO (LA RESPUESTA DEL USUARIO)
        console.log(formatMessageLog('received', ctx.from, ctx.body));

        const userResponse = ctx.body.trim().toLowerCase();
        const infoRuta = rutasDeConversacion.get(ctx.from); // Recuperar estado actualizado

        if (userResponse === 'sí' || userResponse === 'si') {
            // El usuario respondió "Sí"
            // No es necesario infoRuta.validated aquí, lo haremos en el flujoValidacionDni
            console.log(formatMessageLog('info', ctx.from, 'Usuario aceptó TyC, redirigiendo a pregunta de pedido.'));

            // NUEVA PREGUNTA: ¿Deseas realizar un pedido?
            return gotoFlow(flujoContratarServicios_Bolsas);

        } else {
            // El usuario no respondió "Sí" a los TyC
            const offerManualGuideMessage = 'Entendido. Si no aceptas los términos, no podemos continuar con el servicio de compra. ¡Gracias por tu tiempo!';
            await flowDynamic(offerManualGuideMessage);
            console.log(formatMessageLog('sent', ctx.from, 'Usuario no aceptó TyC.'));
            return gotoFlow(flujoFinal_Bolsas);
        }
    });

// Configuración Principal
const main = async () => {
    // Estado temporal de usuarios (memoria volátil)
    rutasDeConversacion.clear(); // Borra el Map para reiniciar el estado de todos los usuarios
    const adapterDB = new MockAdapter();
    const adapterFlows = createFlow([
        flujoBienvenida, // Asegura que el flujo de bienvenida sea el primero
        flujoValidacionDni,
        flujoPedirCodigoVerificacion,
        flujoPreguntaCantidad,
        flujoRecopilacionDireccion,
        flujoConfirmarEntrega,
        flujoPedirCorreoElectronico,
        flujoPedirCiudad,
        flujoPedirFormaPago,
        flujoFinal_Bolsas,
        flujoContratarServicios_Bolsas
    ]);
    const adapterProvider = createProvider(BaileysProvider);

    createBot({
        flow: adapterFlows,
        provider: adapterProvider,
        database: adapterDB
    });

    QRPortalWeb();
};

main();
