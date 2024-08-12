import React, { useEffect, useState, useRef } from "react";

import Grid from "@material-ui/core/Grid";
import FormControl from "@material-ui/core/FormControl";
import { makeStyles } from "@material-ui/core/styles";
import TextField from "@material-ui/core/TextField";
import Typography from '@material-ui/core/Typography';

const useStyles = makeStyles((_) => ({
  fieldContainer: {
    width: "100%",
    textAlign: "left",
  },
  
  uploadInput: {
    display: "none",
  },
}));

export default function OwenAd(props) {
  const classes = useStyles();
  const [owenSettings, setOwenSettings] = useState({});

  useEffect(() => {
  }, []);

  return (
    <>
      <Typography variant="h5" color="primary" gutterBottom>
        Owen Payments apoya a Wbot
      </Typography>    
      <Typography variant="body1">La startup Owen Payments ofrece
      pagos a través de PIX a un costo fijo de R$ 0,99 por operación.</Typography>
      <Typography variant="body1">Una fracción del valor de cada operación
      se destina al proyecto Ticketz, así que al utilizar este medio de pago
      también estarás apoyando el proyecto.</Typography>
      <Typography variant="body1">Selecciona el gateway de pago 
      "Owen Payments 💎" y solicita la apertura de tu cuenta
      sin salir de Ticketz!</Typography>
    </>
  );

}
